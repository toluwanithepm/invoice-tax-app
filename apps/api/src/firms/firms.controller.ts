import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { firmClientCreateSchema, firmConnectSchema, firmCreateSchema, firmInviteSchema, type FirmClientCreate } from '@einv/shared';
import { RateLimit, RequirePermission } from '../common/decorators';
import { ZodPipe } from '../common/zod';
import { FirmsService } from './firms.service';

/** Firm-level routes: no :workspaceId, so FirmsService checks firm membership itself. */
@Controller('v1/firms')
export class FirmsController {
  constructor(private readonly firms: FirmsService) {}

  @Get()
  mine() {
    return this.firms.mine();
  }

  @Post()
  @RateLimit({ name: 'firm-create', limit: 5, windowSec: 3600, by: 'user' })
  create(@Body(new ZodPipe(firmCreateSchema)) body: { name: string }) {
    return this.firms.create(body.name);
  }

  @Get(':firmId')
  get(@Param('firmId', ParseUUIDPipe) firmId: string) {
    return this.firms.get(firmId);
  }

  @Get(':firmId/dashboard')
  dashboard(@Param('firmId', ParseUUIDPipe) firmId: string) {
    return this.firms.dashboard(firmId);
  }

  @Post(':firmId/clients')
  @RateLimit({ name: 'firm-client', limit: 100, windowSec: 3600, by: 'user' })
  createClient(@Param('firmId', ParseUUIDPipe) firmId: string, @Body(new ZodPipe(firmClientCreateSchema)) body: FirmClientCreate) {
    return this.firms.createClient(firmId, body);
  }

  @Post(':firmId/invitations')
  @RateLimit({ name: 'firm-invite', limit: 50, windowSec: 3600, by: 'user' })
  invite(@Param('firmId', ParseUUIDPipe) firmId: string, @Body(new ZodPipe(firmInviteSchema)) body: { email: string; role: 'admin' | 'accountant' }) {
    return this.firms.invite(firmId, body.email, body.role);
  }

  @Delete(':firmId/members/:userId')
  @HttpCode(204)
  removeMember(@Param('firmId', ParseUUIDPipe) firmId: string, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.firms.removeMember(firmId, userId);
  }
}

@Controller('v1/firm-invitations')
export class FirmInvitationsController {
  constructor(private readonly firms: FirmsService) {}

  @Get(':token')
  @RateLimit({ name: 'firm-invite-preview', limit: 30, windowSec: 900, by: 'ip' })
  preview(@Param('token') token: string) {
    return this.firms.previewInvitation(token);
  }

  @Post(':token/accept')
  @HttpCode(200)
  @RateLimit({ name: 'firm-invite-accept', limit: 20, windowSec: 900, by: 'ip' })
  accept(@Param('token') token: string) {
    return this.firms.acceptInvitation(token);
  }
}

/** Client side: give an accounting firm access to this business, or take it away. */
@Controller('v1/workspaces/:workspaceId/firm')
export class WorkspaceFirmController {
  constructor(private readonly firms: FirmsService) {}

  @Get()
  @RequirePermission('workspace.view')
  get() {
    return this.firms.linkedFirm();
  }

  @Post('connect')
  @HttpCode(200)
  @RequirePermission('members.manage')
  @RateLimit({ name: 'firm-connect', limit: 10, windowSec: 900, by: 'user' })
  connect(@Body(new ZodPipe(firmConnectSchema)) body: { code: string }) {
    return this.firms.connect(body.code);
  }

  @Delete()
  @HttpCode(204)
  @RequirePermission('members.manage')
  disconnect() {
    return this.firms.disconnect();
  }
}
