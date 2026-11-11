import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { memberInviteSchema, memberRoleSchema, type Role } from '@einv/shared';
import { RateLimit, RequirePermission } from '../common/decorators';
import { ZodPipe } from '../common/zod';
import { MembersService } from './members.service';

@Controller('v1/workspaces/:workspaceId')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get('members')
  @RequirePermission('workspace.view')
  list() {
    return this.members.list();
  }

  @Post('invitations')
  @RequirePermission('members.manage')
  @RateLimit({ name: 'invite', limit: 50, windowSec: 3600, by: 'user' })
  invite(@Body(new ZodPipe(memberInviteSchema)) body: { email: string; role: Role }) {
    return this.members.invite(body.email, body.role);
  }

  @Delete('invitations/:id')
  @HttpCode(204)
  @RequirePermission('members.manage')
  revoke(@Param('id', ParseUUIDPipe) id: string) {
    return this.members.revokeInvitation(id);
  }

  @Patch('members/:userId')
  @RequirePermission('members.manage')
  changeRole(@Param('userId', ParseUUIDPipe) userId: string, @Body(new ZodPipe(memberRoleSchema)) body: { role: Role }) {
    return this.members.changeRole(userId, body.role);
  }

  @Delete('members/:userId')
  @HttpCode(204)
  @RequirePermission('members.manage')
  remove(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.members.remove(userId);
  }
}

@Controller('v1/invitations')
export class InvitationsController {
  constructor(private readonly members: MembersService) {}

  @Get(':token')
  @RateLimit({ name: 'invite-preview', limit: 30, windowSec: 900, by: 'ip' })
  preview(@Param('token') token: string) {
    return this.members.preview(token);
  }

  @Post(':token/accept')
  @HttpCode(200)
  @RateLimit({ name: 'invite-accept', limit: 20, windowSec: 900, by: 'ip' })
  accept(@Param('token') token: string) {
    return this.members.accept(token);
  }
}
