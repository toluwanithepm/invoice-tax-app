import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { can, workspaceCreateSchema, workspaceUpdateSchema, type WorkspaceCreate, type WorkspaceUpdate } from '@einv/shared';
import { RateLimit, RequirePermission } from '../common/decorators';
import { ZodPipe } from '../common/zod';
import { ctx } from '../common/request-context';
import { AuditService } from '../platform/audit.service';
import { WorkspacesService } from './workspaces.service';

@Controller('v1/workspaces')
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @RateLimit({ name: 'workspace-create', limit: 10, windowSec: 3600, by: 'user' })
  create(@Body(new ZodPipe(workspaceCreateSchema)) body: WorkspaceCreate) {
    return this.workspaces.create(body);
  }

  @Get(':workspaceId')
  @RequirePermission('workspace.view')
  get(@Param('workspaceId') _id: string) {
    return this.workspaces.get({ revealBank: can(ctx().role, 'workspace.manage') });
  }

  @Patch(':workspaceId')
  @RequirePermission('workspace.manage')
  update(@Param('workspaceId') _id: string, @Body(new ZodPipe(workspaceUpdateSchema)) body: WorkspaceUpdate) {
    return this.workspaces.update(body);
  }

  @Get(':workspaceId/summary')
  @RequirePermission('workspace.view')
  summary(@Param('workspaceId') _id: string) {
    return this.workspaces.summary();
  }

  @Post(':workspaceId/tin/verify')
  @HttpCode(200)
  @RequirePermission('workspace.manage')
  @RateLimit({ name: 'tin-verify', limit: 20, windowSec: 3600, by: 'user' })
  verifyTin(@Param('workspaceId') _id: string) {
    return this.workspaces.verifyTin();
  }

  @Put(':workspaceId/logo')
  @RequirePermission('workspace.manage')
  @UseInterceptors(FileInterceptor('logo', { limits: { fileSize: 300 * 1024, files: 1 } }))
  setLogo(@Param('workspaceId') _id: string, @UploadedFile() file?: Express.Multer.File) {
    return this.workspaces.setLogo(file);
  }

  @Get(':workspaceId/logo')
  @RequirePermission('workspace.view')
  async logo(@Param('workspaceId') _id: string, @Res() res: Response) {
    const { data, mime } = await this.workspaces.getLogo();
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type(mime).send(data);
  }

  @Post(':workspaceId/mbs/connect')
  @HttpCode(200)
  @RequirePermission('workspace.manage')
  mbsConnect(@Param('workspaceId') _id: string) {
    return this.workspaces.mbsConnect();
  }

  @Post(':workspaceId/mbs/test')
  @HttpCode(200)
  @RequirePermission('workspace.manage')
  mbsTest(@Param('workspaceId') _id: string) {
    return this.workspaces.mbsTest();
  }

  @Post(':workspaceId/mbs/go-live')
  @HttpCode(200)
  @RequirePermission('workspace.manage')
  mbsGoLive(@Param('workspaceId') _id: string) {
    return this.workspaces.mbsGoLive();
  }

  @Get(':workspaceId/audit')
  @RequirePermission('audit.view')
  auditLog(
    @Param('workspaceId') _id: string,
    @Query(
      new ZodPipe(
        z.object({
          entity: z.string().max(40).optional(),
          entityId: z.string().max(64).optional(),
          cursor: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      ),
    )
    q: { entity?: string; entityId?: string; cursor?: string; limit: number },
  ) {
    return this.audit.list(q);
  }
}
