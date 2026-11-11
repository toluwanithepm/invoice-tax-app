import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { importCommitSchema } from '@einv/shared';
import { RateLimit, RequirePermission } from '../common/decorators';
import { ZodPipe } from '../common/zod';
import { B2cService } from './b2c.service';

const dateParam = new ZodPipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.'));

@Controller('v1/workspaces/:workspaceId/b2c')
export class B2cController {
  constructor(private readonly b2c: B2cService) {}

  @Get('days')
  @RequirePermission('workspace.view')
  days(@Query(new ZodPipe(z.object({ days: z.coerce.number().int().min(1).max(62).default(14) }))) q: { days: number }) {
    return this.b2c.days(q.days);
  }

  @Put('settings')
  @RequirePermission('workspace.manage')
  settings(@Body(new ZodPipe(z.object({ enabled: z.boolean() }))) body: { enabled: boolean }) {
    return this.b2c.setEnabled(body.enabled);
  }

  @Get('days/:date')
  @RequirePermission('workspace.view')
  rows(@Param('date', dateParam) date: string) {
    return this.b2c.rows(date);
  }

  @Post('days/:date/submit')
  @HttpCode(200)
  @RequirePermission('b2c.manage')
  submit(@Param('date', dateParam) date: string) {
    return this.b2c.submitDay(date);
  }

  @Post('days/:date/no-sales')
  @HttpCode(200)
  @RequirePermission('b2c.manage')
  noSales(@Param('date', dateParam) date: string) {
    return this.b2c.noSales(date);
  }

  @Delete('days/:date')
  @HttpCode(204)
  @RequirePermission('b2c.manage')
  remove(@Param('date', dateParam) date: string) {
    return this.b2c.deleteDay(date);
  }

  @Post('uploads')
  @RequirePermission('b2c.manage')
  @RateLimit({ name: 'b2c-upload', limit: 60, windowSec: 3600, by: 'user' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  upload(@UploadedFile() file?: Express.Multer.File) {
    return this.b2c.upload(file);
  }

  @Post('uploads/:id/commit')
  @HttpCode(200)
  @RequirePermission('b2c.manage')
  commit(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(importCommitSchema)) body: { mapping: Record<string, string> }, @Query('dryRun') dryRun?: string) {
    return this.b2c.commit(id, body.mapping, dryRun === 'true');
  }
}

/** POS export template (E5-2). */
@Controller('v1/b2c-template')
export class B2cTemplateController {
  @Get()
  template() {
    return {
      fileName: 'b2c-sales-template.csv',
      csv: 'date,receipt_no,description,amount,vat,buyer_name,buyer_phone\n2026-11-10,R-000123,Bread and milk,2150,standard,,\n2026-11-10,R-000124,Medicine,4800,exempt,Ada,08031234567\n',
    };
  }
}
