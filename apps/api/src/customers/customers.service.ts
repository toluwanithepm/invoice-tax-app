import { Inject, Injectable } from '@nestjs/common';
import type { Customer } from '@prisma/client';
import type { CustomerInput } from '@einv/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../platform/audit.service';
import { TAX_ID_REGISTRY, type TaxIdRegistry } from '../access-point/access-point';
import { conflict, notFound } from '../common/errors';
import { requireWorkspaceId } from '../common/request-context';

export const customerDto = (c: Customer) => ({
  id: c.id,
  name: c.name,
  kind: c.kind,
  tin: c.tin,
  registryName: c.registryName,
  email: c.email,
  phone: c.phone,
  address: c.address,
  archived: !!c.archivedAt,
  createdAt: c.createdAt.toISOString(),
});

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(TAX_ID_REGISTRY) private readonly registry: TaxIdRegistry,
  ) {}

  async list(q: { q?: string; cursor?: string; limit: number; includeArchived?: boolean }) {
    const rows = await this.prisma.scoped().customer.findMany({
      where: {
        archivedAt: q.includeArchived ? undefined : null,
        ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { tin: { contains: q.q } }] } : {}),
      },
      orderBy: { name: 'asc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit);
    return { items: items.map(customerDto), nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null };
  }

  async get(id: string) {
    const c = await this.prisma.scoped().customer.findUnique({ where: { id } });
    if (!c) throw notFound('That customer');
    return customerDto(c);
  }

  /** E2-1: flags a duplicate Tax ID unless the user confirms (branches of one company can share a TIN). */
  async create(input: CustomerInput, allowDuplicate = false) {
    const db = this.prisma.scoped();
    if (!allowDuplicate) {
      const dup = await db.customer.findFirst({ where: { tin: input.tin, archivedAt: null } });
      if (dup) {
        throw conflict(`You already have a customer with this Tax ID: ${dup.name}.`, 'DUPLICATE_CUSTOMER', {
          existing: customerDto(dup),
        });
      }
    }
    const record = await this.registry.lookup(input.tin);
    const c = await db.customer.create({
      data: { ...input, workspaceId: requireWorkspaceId(), registryName: record.legalName ?? null },
    });
    await this.audit.record({ entity: 'customer', entityId: c.id, action: 'customer.created' });
    return { ...customerDto(c), tinFound: record.found };
  }

  async update(id: string, input: CustomerInput) {
    const db = this.prisma.scoped();
    const existing = await db.customer.findUnique({ where: { id } });
    if (!existing) throw notFound('That customer');
    const registryName = input.tin !== existing.tin ? ((await this.registry.lookup(input.tin)).legalName ?? null) : existing.registryName;
    const c = await db.customer.update({ where: { id }, data: { ...input, registryName } });
    await this.audit.record({ entity: 'customer', entityId: id, action: 'customer.updated' });
    return customerDto(c);
  }

  async archive(id: string) {
    const r = await this.prisma.scoped().customer.updateMany({ where: { id }, data: { archivedAt: new Date() } });
    if (!r.count) throw notFound('That customer');
    await this.audit.record({ entity: 'customer', entityId: id, action: 'customer.archived' });
  }

  lookupTin(tin: string) {
    return this.registry.lookup(tin);
  }
}
