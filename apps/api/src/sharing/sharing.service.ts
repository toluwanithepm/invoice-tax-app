import { Injectable } from '@nestjs/common';
import { DOC_TYPE_LABELS, formatNaira, phoneSchema, type DocType } from '@einv/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../platform/audit.service';
import { NotificationsService } from '../platform/notifications.service';
import { badRequest, notFound } from '../common/errors';
import { decrypt, randomToken, sha256 } from '../common/crypto';
import { ctx, requireUserId, requireWorkspaceId } from '../common/request-context';
import { env } from '../config/env';
import { InvoicesService } from '../invoices/invoices.service';
import { invoiceDto } from '../invoices/invoice.mapper';
import { PdfService, type SellerView } from '../documents/pdf.service';

/**
 * E3-6: share a cleared invoice by link, email or WhatsApp. Each share mints its own 128-bit
 * token; only the SHA-256 is stored, links are read-only, scoped to one invoice and revocable.
 */
@Injectable()
export class SharingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
    private readonly audit: AuditService,
    private readonly notify: NotificationsService,
    private readonly pdf: PdfService,
  ) {}

  async share(invoiceId: string, channel: 'link' | 'email' | 'whatsapp', recipient?: string) {
    const inv = await this.invoices.getRaw(invoiceId);
    if (inv.status !== 'cleared') throw badRequest('Only cleared invoices can be shared.', [], 'NOT_CLEARED');
    const workspaceId = requireWorkspaceId();
    const ws = await this.prisma.scoped().workspace.findUniqueOrThrow({ where: { id: workspaceId } });

    let to: string | null = null;
    if (channel === 'email') {
      to = recipient ?? inv.customer?.email ?? null;
      if (!to || !/^\S+@\S+\.\S+$/.test(to)) throw badRequest('Enter the email address to send to.', [{ field: 'recipient', message: 'Enter an email address.' }]);
    }
    if (channel === 'whatsapp' && (recipient || inv.customer?.phone)) {
      const p = phoneSchema.safeParse(recipient ?? inv.customer?.phone);
      if (!p.success) throw badRequest(p.error.issues[0]!.message, [{ field: 'recipient', message: p.error.issues[0]!.message }]);
      to = p.data;
    }

    const token = randomToken(16);
    const link = await this.prisma.scoped().shareLink.create({
      data: { workspaceId, invoiceId, tokenHash: sha256(token), channel, recipient: to, createdBy: requireUserId() },
    });
    const url = `${env().PUBLIC_APP_URL}/i/${token}`;
    const sellerName = ws.tradingName ?? ws.legalName;
    const label = DOC_TYPE_LABELS[inv.docType as DocType].toLowerCase();
    const message = `${sellerName} sent you ${label} ${inv.number} for ${formatNaira(Number(inv.total))} (IRN ${inv.irn}). View and download it here: ${url}`;

    let whatsappUrl: string | null = null;
    if (channel === 'email') {
      await this.notify.send({ workspaceId, channel: 'email', recipient: to!, subject: `${DOC_TYPE_LABELS[inv.docType as DocType]} ${inv.number} from ${sellerName}`, body: message });
    }
    if (channel === 'whatsapp') {
      // Phase 1: click-to-chat link opened on the user's phone. WhatsApp Business API sending is Phase 4.
      whatsappUrl = `https://wa.me/${to ? to.replace('+', '') : ''}?text=${encodeURIComponent(message)}`;
    }
    if (channel !== 'link') {
      await this.prisma.scoped().shareEvent.create({ data: { workspaceId, shareLinkId: link.id, event: 'sent' } });
    }
    await this.audit.record({ entity: 'invoice', entityId: invoiceId, action: 'invoice.shared', detail: { channel, recipient: to } });
    return { id: link.id, url, whatsappUrl, channel, recipient: to };
  }

  async listShares(invoiceId: string) {
    const links = await this.prisma.scoped().shareLink.findMany({
      where: { invoiceId },
      include: { events: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
    return links.map((l) => ({
      id: l.id,
      channel: l.channel,
      recipient: l.recipient,
      createdAt: l.createdAt.toISOString(),
      revoked: !!l.revokedAt,
      events: l.events.map((e) => ({ event: e.event, at: e.createdAt.toISOString() })),
    }));
  }

  async revoke(invoiceId: string, shareId: string) {
    const r = await this.prisma.scoped().shareLink.updateMany({ where: { id: shareId, invoiceId }, data: { revokedAt: new Date() } });
    if (!r.count) throw notFound('That link');
    await this.audit.record({ entity: 'invoice', entityId: invoiceId, action: 'invoice.share_revoked', detail: { shareId } });
  }

  // ── Public (token) access ───────────────────────────────────────────

  private async resolve(token: string) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw notFound('That invoice link');
    const rows = await this.prisma.$queryRaw<{ share_link_id: string; workspace_id: string; invoice_id: string }[]>`
      SELECT * FROM app.resolve_share_token(${sha256(token)})`;
    const r = rows[0];
    if (!r) throw notFound('That invoice link (it may have been withdrawn)');
    return r;
  }

  private async logEvent(r: { share_link_id: string; workspace_id: string }, event: 'viewed' | 'downloaded') {
    await this.prisma.scoped({ workspaceId: r.workspace_id, userId: null }).shareEvent.create({
      data: { workspaceId: r.workspace_id, shareLinkId: r.share_link_id, event, ip: ctx().ip ?? null, userAgent: ctx().userAgent?.slice(0, 300) ?? null },
    });
  }

  private async load(r: { workspace_id: string; invoice_id: string }) {
    const db = this.prisma.scoped({ workspaceId: r.workspace_id, userId: null });
    const inv = await db.invoice.findUnique({
      where: { id: r.invoice_id },
      include: { lines: true, originalInvoice: true },
    });
    if (!inv || inv.status !== 'cleared') throw notFound('That invoice');
    const ws = await db.workspace.findUniqueOrThrow({ where: { id: r.workspace_id }, select: { logo: true, brandColor: true } });
    return { inv, ws };
  }

  /** Mobile-friendly public view (no internal ids, no audit data). */
  async publicView(token: string) {
    const r = await this.resolve(token);
    const { inv, ws } = await this.load(r);
    await this.logEvent(r, 'viewed');
    const dto = invoiceDto(inv);
    const seller = inv.sellerSnapshot as unknown as SellerView;
    return {
      docType: dto.docType,
      number: dto.number,
      issueDate: dto.issueDate,
      dueDate: dto.dueDate,
      irn: dto.irn,
      qrPayload: dto.qrPayload,
      clearedAt: dto.clearedAt,
      seller: {
        name: seller.name,
        tradingName: seller.tradingName ?? null,
        tin: seller.tin,
        address: seller.address,
        email: seller.email ?? null,
        phone: seller.phone ?? null,
        bankName: seller.bankName ?? null,
        bankAccountName: seller.bankAccountName ?? null,
        bankAccountNumber: seller.bankAccountEnc ? decrypt(seller.bankAccountEnc) : null,
        terms: seller.invoiceTerms ?? null,
        brandColor: ws.brandColor,
        hasLogo: !!ws.logo,
      },
      buyer: dto.buyer,
      originalInvoice: dto.originalInvoice ? { number: dto.originalInvoice.number, irn: dto.originalInvoice.irn } : null,
      reason: dto.reason,
      notes: dto.notes,
      lines: dto.lines.map(({ id: _id, productId: _p, ...l }) => l),
      subtotal: dto.subtotal,
      discountTotal: dto.discountTotal,
      vatTotal: dto.vatTotal,
      total: dto.total,
    };
  }

  async publicPdf(token: string) {
    const r = await this.resolve(token);
    const { inv, ws } = await this.load(r);
    await this.logEvent(r, 'downloaded');
    const seller = { ...(inv.sellerSnapshot as unknown as SellerView), brandColor: ws.brandColor };
    const buf = await this.pdf.render(invoiceDto(inv), seller, ws.logo ? { data: Buffer.from(ws.logo) } : null);
    return { buf, fileName: `${inv.number}.pdf` };
  }

  async publicLogo(token: string) {
    const r = await this.resolve(token);
    const ws = await this.prisma
      .scoped({ workspaceId: r.workspace_id, userId: null })
      .workspace.findUniqueOrThrow({ where: { id: r.workspace_id }, select: { logo: true, logoMime: true } });
    if (!ws.logo) throw notFound('A logo');
    return { data: Buffer.from(ws.logo), mime: ws.logoMime ?? 'image/png' };
  }
}
