import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { adjustmentNoteSchema, invoiceDraftSchema, listQuerySchema, shareSchema, type AdjustmentNoteInput, type InvoiceDraft } from '@einv/shared';
import { RateLimit, RequirePermission } from '../common/decorators';
import { ZodPipe } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import { requireWorkspaceId } from '../common/request-context';
import { ClearanceService } from '../clearance/clearance.service';
import { PdfService, type SellerView } from '../documents/pdf.service';
import { SharingService } from '../sharing/sharing.service';
import { invoiceDto } from './invoice.mapper';
import { InvoicesService } from './invoices.service';

const listQuery = listQuerySchema.extend({
  docType: z.enum(['invoice', 'credit_note', 'debit_note']).optional(),
  customerId: z.string().uuid().optional(),
});

@Controller('v1/workspaces/:workspaceId/invoices')
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly clearance: ClearanceService,
    private readonly sharing: SharingService,
    private readonly pdf: PdfService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @RequirePermission('workspace.view')
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.invoices.list(q);
  }

  @Post()
  @RequirePermission('invoices.edit')
  create(@Body(new ZodPipe(invoiceDraftSchema)) body: InvoiceDraft) {
    return this.invoices.createDraft(body);
  }

  @Get(':id')
  @RequirePermission('workspace.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.get(id);
  }

  @Put(':id')
  @RequirePermission('invoices.edit')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(invoiceDraftSchema)) body: InvoiceDraft) {
    return this.invoices.updateDraft(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('invoices.edit')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.deleteDraft(id);
  }

  @Post(':id/validate')
  @HttpCode(200)
  @RequirePermission('invoices.edit')
  validate(@Param('id', ParseUUIDPipe) id: string) {
    return this.clearance.validate(id);
  }

  /** Clerks may call this too: with approvals on it routes to an approver; without, clerks are refused. */
  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermission('invoices.edit')
  @RateLimit({ name: 'submit', limit: 600, windowSec: 3600, by: 'user' })
  async submit(@Param('id', ParseUUIDPipe) id: string) {
    return this.clearance.submitChecked(id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('invoices.approve')
  approve(@Param('id', ParseUUIDPipe) id: string) {
    return this.clearance.approve(id);
  }

  @Post(':id/decline')
  @HttpCode(200)
  @RequirePermission('invoices.approve')
  decline(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ reason: z.string().trim().min(3).max(500) }))) body: { reason: string }) {
    return this.clearance.rejectApproval(id, body.reason);
  }

  @Get(':id/credit-template')
  @RequirePermission('invoices.edit')
  creditTemplate(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.creditTemplate(id);
  }

  @Post(':id/credit-notes')
  @RequirePermission('invoices.edit')
  creditNote(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(adjustmentNoteSchema)) body: AdjustmentNoteInput) {
    return this.invoices.createAdjustment(id, 'credit_note', body);
  }

  @Post(':id/debit-notes')
  @RequirePermission('invoices.edit')
  debitNote(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(adjustmentNoteSchema)) body: AdjustmentNoteInput) {
    return this.invoices.createAdjustment(id, 'debit_note', body);
  }

  @Get(':id/pdf')
  @RequirePermission('workspace.view')
  async pdfDownload(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const inv = await this.invoices.getRaw(id);
    const ws = await this.prisma.scoped().workspace.findUniqueOrThrow({ where: { id: requireWorkspaceId() } });
    const seller: SellerView = inv.sellerSnapshot
      ? { ...(inv.sellerSnapshot as unknown as SellerView), brandColor: ws.brandColor }
      : {
          name: ws.legalName,
          tradingName: ws.tradingName,
          tin: ws.tin,
          address: ws.address,
          email: ws.email,
          phone: ws.phone,
          bankName: ws.bankName,
          bankAccountName: ws.bankAccountName,
          bankAccountEnc: ws.bankAccountEnc,
          invoiceTerms: ws.invoiceTerms,
          brandColor: ws.brandColor,
        };
    const buf = await this.pdf.render(invoiceDto(inv), seller, ws.logo ? { data: Buffer.from(ws.logo) } : null);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${inv.number ?? 'draft'}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buf);
  }

  @Post(':id/share')
  @RequirePermission('invoices.share')
  @RateLimit({ name: 'share', limit: 200, windowSec: 3600, by: 'user' })
  share(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(shareSchema)) body: z.infer<typeof shareSchema>) {
    return this.sharing.share(id, body.channel, body.recipient);
  }

  @Get(':id/shares')
  @RequirePermission('workspace.view')
  shares(@Param('id', ParseUUIDPipe) id: string) {
    return this.sharing.listShares(id);
  }

  @Delete(':id/shares/:shareId')
  @HttpCode(204)
  @RequirePermission('invoices.share')
  revokeShare(@Param('id', ParseUUIDPipe) id: string, @Param('shareId', ParseUUIDPipe) shareId: string) {
    return this.sharing.revoke(id, shareId);
  }
}
