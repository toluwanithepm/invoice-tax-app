import { Body, Controller, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { otpRequestSchema, otpVerifySchema, totpCodeSchema, type OtpRequest, type OtpVerify } from '@einv/shared';
import { AllowPending2fa, Public, RateLimit } from '../common/decorators';
import { ZodPipe } from '../common/zod';
import { ctx, requireUserId } from '../common/request-context';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Post('otp/request')
  @HttpCode(200)
  requestOtp(@Body(new ZodPipe(otpRequestSchema)) body: OtpRequest) {
    return this.auth.requestOtp(body);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  @RateLimit({ name: 'otp-verify', limit: 30, windowSec: 900, by: 'ip' })
  verifyOtp(
    @Body(new ZodPipe(otpVerifySchema)) body: OtpVerify,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.verifyOtp(body, req, res);
  }

  @Post('logout')
  @HttpCode(204)
  @AllowPending2fa()
  async logout(@Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(ctx().sessionId!);
    this.sessions.clearCookies(res);
  }

  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(@Res({ passthrough: true }) res: Response) {
    await this.sessions.revokeAll(requireUserId());
    this.sessions.clearCookies(res);
  }

  @Post('2fa/setup')
  @HttpCode(200)
  setup2fa() {
    return this.auth.setupTotp(requireUserId());
  }

  @Post('2fa/enable')
  @HttpCode(200)
  enable2fa(@Body(new ZodPipe(totpCodeSchema)) body: { code: string }, @Res({ passthrough: true }) res: Response) {
    return this.auth.enableTotp(requireUserId(), body.code, res);
  }

  @Post('2fa/verify')
  @HttpCode(200)
  @AllowPending2fa()
  verify2fa(@Body(new ZodPipe(totpCodeSchema)) body: { code: string }, @Res({ passthrough: true }) res: Response) {
    return this.auth.verifyTotp(requireUserId(), body.code, res);
  }

  @Post('2fa/disable')
  @HttpCode(200)
  disable2fa(@Body(new ZodPipe(totpCodeSchema)) body: { code: string }) {
    return this.auth.disableTotp(requireUserId(), body.code);
  }
}

@Controller('v1/me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  @AllowPending2fa()
  me() {
    return this.auth.me(requireUserId());
  }

  @Patch()
  update(@Body(new ZodPipe(z.object({ name: z.string().trim().min(1).max(120) }))) body: { name: string }) {
    return this.auth.updateName(requireUserId(), body.name);
  }

  @Get('export')
  export() {
    return this.auth.exportPersonalData(requireUserId());
  }

  @Post('deletion-request')
  @HttpCode(202)
  deletion() {
    return this.auth.requestDeletion(requireUserId());
  }
}
