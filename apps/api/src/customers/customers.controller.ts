import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { customerSchema, isValidTin, listQuerySchema, normaliseTin, TIN_HINT, type CustomerInput } from '@einv/shared';
import { RateLimit, RequirePermission } from '../common/decorators';
import { badRequest } from '../common/errors';
import { ZodPipe } from '../common/zod';
import { CustomersService } from './customers.service';

const listQuery = listQuerySchema.extend({ includeArchived: z.coerce.boolean().optional() });

@Controller('v1/workspaces/:workspaceId/customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermission('workspace.view')
  list(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.customers.list(q);
  }

  @Get(':id')
  @RequirePermission('workspace.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.get(id);
  }

  @Post()
  @RequirePermission('records.edit')
  create(@Body(new ZodPipe(customerSchema)) body: CustomerInput, @Query('allowDuplicate') allowDuplicate?: string) {
    return this.customers.create(body, allowDuplicate === 'true');
  }

  @Put(':id')
  @RequirePermission('records.edit')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(customerSchema)) body: CustomerInput) {
    return this.customers.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('records.edit')
  archive(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.archive(id);
  }
}

/** Buyer Tax ID check used while typing a customer's details (E2-1). */
@Controller('v1/workspaces/:workspaceId/tin-lookup')
export class TinLookupController {
  constructor(private readonly customers: CustomersService) {}

  @Get(':tin')
  @RequirePermission('records.edit')
  @RateLimit({ name: 'tin-lookup', limit: 60, windowSec: 600, by: 'user' })
  async lookup(@Param('tin') raw: string) {
    const tin = normaliseTin(raw);
    if (!isValidTin(tin)) throw badRequest(TIN_HINT, [{ field: 'tin', message: TIN_HINT }]);
    return this.customers.lookupTin(tin);
  }
}
