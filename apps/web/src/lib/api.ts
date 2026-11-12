/**
 * Browser API client. All calls go to same-origin /api/* (proxied to the Nest API), so the session
 * cookie is first-party and httpOnly. State-changing calls echo the CSRF cookie in X-CSRF-Token.
 */
export interface FieldError {
  field: string | null;
  message: string;
  code?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly errors: FieldError[] = [],
    readonly body: Record<string, unknown> = {},
  ) {
    super(detail);
  }
}

function csrfToken() {
  if (typeof document === 'undefined') return '';
  const m = document.cookie.match(/(?:^|;\s*)(?:__Host-)?csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : '';
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown, opts: { silent?: boolean } = {}): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-CSRF-Token': csrfToken() } : {}),
    },
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? safeJson(text) : {};
  if (!res.ok) {
    const p = data as { code?: string; detail?: string; errors?: FieldError[] };
    const err = new ApiError(
      res.status,
      p.code ?? 'HTTP_' + res.status,
      p.detail ?? (res.status >= 500 ? 'Something went wrong on our side. Try again.' : 'That request failed.'),
      p.errors ?? [],
      data as Record<string, unknown>,
    );
    if (!opts.silent) handleAuthRedirects(err);
    throw err;
  }
  return data as T;
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const PUBLIC_PATHS = ['/login', '/signup', '/i/', '/2fa', '/help', '/verify', '/billing/test-checkout'];
function handleAuthRedirects(err: ApiError) {
  if (typeof window === 'undefined') return;
  const here = window.location.pathname;
  if (here === '/' || PUBLIC_PATHS.some((p) => here.startsWith(p))) return;
  if (err.status === 401 && err.code === 'MFA_REQUIRED') {
    window.location.assign(`/2fa?next=${encodeURIComponent(here + window.location.search)}`);
  } else if (err.status === 401) {
    window.location.assign(`/login?next=${encodeURIComponent(here + window.location.search)}&expired=1`);
  }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  /** GET that never redirects to sign-in (for public pages that adapt to signed-in users). */
  peek: <T>(path: string) => request<T>('GET', path, undefined, { silent: true }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T = void>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, form: FormData, method: 'POST' | 'PUT' = 'POST') => request<T>(method, path, form),
};

/** Maps API field errors onto react-hook-form fields; returns the ones that had no matching field. */
export function applyFieldErrors(
  err: unknown,
  setError: (name: any, e: { message: string }) => void,
  known: string[],
): FieldError[] {
  if (!(err instanceof ApiError)) return [];
  const rest: FieldError[] = [];
  for (const e of err.errors) {
    if (e.field && known.some((k) => e.field === k || e.field!.startsWith(k + '.'))) setError(e.field, { message: e.message });
    else rest.push(e);
  }
  return rest;
}

export const errorMessage = (err: unknown) => (err instanceof ApiError ? err.detail : 'Something went wrong. Check your connection and try again.');

/**
 * E10: a 402 means sending is paused by the plan (trial ended, limit reached, payment lapsed).
 * Shows the reason with a way to fix it; returns true when it handled the error.
 */
export function planBlockToast(err: unknown, workspaceId: string, toastFn: (msg: string, opts: { action: { label: string; onClick: () => void }; duration: number }) => unknown) {
  if (!(err instanceof ApiError) || err.status !== 402) return false;
  toastFn(err.detail, { action: { label: 'See plans', onClick: () => window.location.assign(`/w/${workspaceId}/billing`) }, duration: 10_000 });
  return true;
}
