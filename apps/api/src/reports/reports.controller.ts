import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { markPaidSchema, monthSchema, vatDeclarationSchema, type VatDeclarationInput } from '@einv/shared';
import { RequirePermission } from '../common/decorators';
import { ZodPipe } from '../common/zod';
import { ReportsService } from './reports.service';

@Controller('v1/workspaces/:workspaceId/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  @RequirePermission('reports.view')
  dashboard(
    @Query(new ZodPipe(z.object({ months: z.coerce.number().int().min(1).max(24).default(12), customerId: z.string().uuid().optional() })))
    q: { months: number; customerId?: string },
  ) {
    return this.reports.dashboard(q);
  }

  @Get('vat/:month')
  @RequirePermission('reports.view')
  vat(@Param('month', new ZodPipe(monthSchema)) month: string) {
    return this.reports.reconciliation(month);
  }

  @Put('vat/:month/declaration')
  @RequirePermission('vat.declare')
  declare(@Param('month', new ZodPipe(monthSchema)) month: string, @Body(new ZodPipe(vatDeclarationSchema)) body: VatDeclarationInput) {
    return this.reports.declare(month, body);
  }

  @Get('vat/:month/export.xlsx')
  @RequirePermission('reports.view')
  async xlsx(@Param('month', new ZodPipe(monthSchema)) month: string, @Res() res: Response) {
    const buf = await this.reports.toXlsx(await this.reports.reconciliation(month));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="vat-reconciliation-${month}.xlsx"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buf);
  }

  @Get('vat/:month/export.pdf')
  @RequirePermission('reports.view')
  async pdf(@Param('month', new ZodPipe(monthSchema)) month: string, @Res() res: Response) {
    const buf = await this.reports.toPdf(await this.reports.reconciliation(month));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="vat-reconciliation-${month}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buf);
  }
}

@Controller('v1/workspaces/:workspaceId/invoices')
export class InvoicePaymentsController {
  constructor(private readonly reports: ReportsService) {}

  @Patch(':id/payment')
  @RequirePermission('invoices.payments')
  setPaid(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(markPaidSchema)) body: { paid: boolean; paidOn?: string }) {
    return this.reports.setPaid(id, body.paid, body.paidOn);
  }
}
