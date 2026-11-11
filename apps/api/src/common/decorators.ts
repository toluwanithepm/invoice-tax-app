import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@einv/shared';

export const PUBLIC_KEY = 'route:public';
export const PERMISSION_KEY = 'route:permission';
export const SKIP_CSRF_KEY = 'route:skipCsrf';
export const RATE_LIMIT_KEY = 'route:rateLimit';
export const ALLOW_PENDING_2FA_KEY = 'route:allowPending2fa';

/** No session required. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** Route is under /workspaces/:workspaceId and needs this permission (deny by default otherwise). */
export const RequirePermission = (p: Permission) => SetMetadata(PERMISSION_KEY, p);
/** Machine-to-machine endpoint authenticated another way (e.g. cron secret). */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF_KEY, true);
/** Session may be used before its 2FA step is complete (2FA verify/setup endpoints). */
export const AllowPending2fa = () => SetMetadata(ALLOW_PENDING_2FA_KEY, true);

export interface RateLimitRule {
  name: string;
  limit: number;
  windowSec: number;
  by: 'ip' | 'user';
}
export const RateLimit = (rule: RateLimitRule) => SetMetadata(RATE_LIMIT_KEY, rule);
