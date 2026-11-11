import { Body, Controller, Delete, Get, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import type { Product } from '@prisma/client';
import { z } from 'zod';
import { listQuerySchema, productSchema, type ProductInput } from '@einv/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../platform/audit.service';
import { RequirePermission } from '../common/decorators';
import { notFound } from '../common/errors';
import { num, ZodPipe } from '../common/zod';
import { requireWorkspaceId } from '../common/request-context';

export const productDto = (p: Product) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  sku: p.sku,
  unitPrice: num(p.unitPrice),
  vatTreatment: p.vatTreatment,
  archived: !!p.archivedAt,
});

/** E2-2: products and services, each with a required VAT treatment. */
@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: { q?: string; cursor?: string; limit: number }) {
    const rows = await this.prisma.scoped().product.findMany({
      where: {
        archivedAt: null,
        ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { sku: { contains: q.q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { name: 'asc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit);
    return { items: items.map(productDto), nextCursor: rows.length > q.limit ? items[items.length - 1]!.id : null };
  }

  async get(id: string) {
    const p = await this.prisma.scoped().product.findUnique({ where: { id } });
    if (!p) throw notFound('That product');
    return productDto(p);
  }

  async create(input: ProductInput) {
    const p = await this.prisma.scoped().product.create({ data: { ...input, workspaceId: requireWorkspaceId() } });
    await this.audit.record({ entity: 'product', entityId: p.id, action: 'product.created' });
    return productDto(p);
  }

  async update(id: string, input: ProductInput) {
    const db = this.prisma.scoped();
    if (!(await db.product.findUnique({ where: { id } }))) throw notFound('That product');
    const p = await db.product.update({ where: { id }, data: input });
    await this.audit.record({ entity: 'product', entityId: id, action: 'product.updated' });
    return productDto(p);
  }

  async archive(id: string) {
    const r = await this.prisma.scoped().product.updateMany({ where: { id }, data: { archivedAt: new Date() } });
    if (!r.count) throw notFound('That product');
    await this.audit.record({ entity: 'product', entityId: id, action: 'product.archived' });
  }
}

@Controller('v1/workspaces/:workspaceId/products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @RequirePermission('workspace.view')
  list(@Query(new ZodPipe(listQuerySchema)) q: z.infer<typeof listQuerySchema>) {
    return this.products.list(q);
  }

  @Get(':id')
  @RequirePermission('workspace.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.get(id);
  }

  @Post()
  @RequirePermission('records.edit')
  create(@Body(new ZodPipe(productSchema)) body: ProductInput) {
    return this.products.create(body);
  }

  @Put(':id')
  @RequirePermission('records.edit')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(productSchema)) body: ProductInput) {
    return this.products.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('records.edit')
  archive(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.archive(id);
  }
}
