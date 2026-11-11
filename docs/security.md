# Security architecture

Scope: the SME e-invoicing platform (FRD: "SME E-Invoicing and Tax Compliance Platform").
The product's core promise is that a cleared invoice is correct, can't be tampered with, and only
the right people in the right business can see or issue it. A missed or wrong clearance means a
customer doesn't get paid, so integrity and availability matter as much as confidentiality.

## 1. Threat model (STRIDE)

| Threat | Example | Controls |
|---|---|---|
| **Spoofing** – account takeover | Stolen phone/email, OTP brute force, session theft | Passwordless OTP (6 digits, 5-min TTL, HMAC-hashed, 5 attempts, single use, rate-limited per identifier and IP); optional TOTP 2FA with hashed recovery codes; workspace can *require* 2FA for owner/admin/accountant; httpOnly `__Host-` session cookie; 30-min idle / 12-h absolute expiry; token rotation on 2FA; "sign out everywhere" |
| **Tampering** – altering an accepted B2C report | Insider edits a day's sales after NRS accepted it | DB triggers block updates to accepted reports and their sales (`app.lock_accepted_b2c*`) |
| **Tampering** – altering a cleared invoice | Insider edits totals after clearance | DB trigger blocks any change to a cleared invoice or its lines except the paid date (`app.lock_cleared_invoice`, `app.lock_cleared_lines`); corrections only via credit/debit notes linked to the IRN; buyer/seller snapshots frozen at submission |
| **Tampering** – client-side totals | Browser sends a wrong total | Server always recomputes totals from lines in integer kobo (`packages/shared/src/vat.ts`); MBS rule NRS-E106 double-checks |
| **Repudiation** | "I didn't submit that" | Append-only `audit_events` (no UPDATE/DELETE grant + trigger), actor, IP, request id; every clearance attempt stored with request hash and response |
| **Information disclosure** – cross-tenant leak | Bug omits a `workspace_id` filter | Two layers: (1) `WorkspaceGuard` requires membership + explicit permission on every `:workspaceId` route; (2) Postgres RLS on every tenant table, API connects as `app_runtime` (no BYPASSRLS), context set per transaction. Automated cross-tenant tests in CI |
| **Information disclosure** – data at rest | DB dump leaks bank details | AES-256-GCM field encryption for bank account numbers and TOTP secrets; sessions/OTPs/tokens stored only as hashes; Supabase disk encryption |
| **Information disclosure** – share links | Link forwarded or guessed | 128-bit random token, hash stored, one invoice, read-only, revocable, cleared invoices only, `noindex`, rate-limited, views logged |
| **Denial of service** | OTP/SMS pumping, import bombs | Postgres-backed rate limits (work across serverless instances); 5 MB / 5,000-row import cap; 1 MB JSON body cap; 300 KB logo cap |
| **Elevation of privilege** | Clerk submits invoices, admin makes self owner | Role → permission matrix in `packages/shared/src/roles.ts`, deny by default; only owners grant/revoke owner; last owner can't be removed |
| **Duplicate / forged IRNs** | Retry produces two IRNs | Idempotency key = invoice id + hash of the UBL document; conditional status transitions; IRN unique constraint |

## 2. Authentication

- **Sign-in:** email or Nigerian mobile + 6-digit OTP. The response to "send code" is identical for
  new and existing accounts (no enumeration). New accounts must record consent (NDPA) — stored in
  `consent_records` with notice version and IP.
- **NFR-7 ("OTP or 2FA required for Owner, Admin and Accountant"):** every sign-in is OTP-verified,
  which meets the requirement for all roles. TOTP is an additional factor a user can enable, and a
  workspace can make it mandatory for privileged roles (`require_2fa`).
- **Sessions:** opaque 256-bit token in an httpOnly, Secure, SameSite=Lax cookie (`__Host-sid` in
  production). Only SHA-256(token) is stored. Idle timeout 30 min, absolute 12 h.

## 3. CSRF

Cookie-authenticated, so three layers: SameSite=Lax; `Origin`/`Referer` must match `WEB_ORIGIN` on
every state-changing request; double-submit token (`csrf` cookie echoed in `X-CSRF-Token`) whenever a
session cookie is present. The cron endpoint skips CSRF and uses a bearer secret instead.

## 4. Authorization and tenancy

```
request ─▶ CsrfGuard ─▶ SessionGuard ─▶ WorkspaceGuard ─▶ RateLimitGuard ─▶ handler
                                          │  membership(user, :workspaceId)?  404 if not
                                          │  @RequirePermission present?      403 if not (deny by default)
                                          │  role allows permission?          403 if not
                                          ▼
                     PrismaService.scoped(): every query runs as
                     [set_config('app.workspace_id'), set_config('app.user_id'), query] in one transaction
                                          ▼
                     Postgres RLS: workspace_id = app.current_workspace_id()
```

- Tables live in schema `app`, which Supabase's Data API does not expose; `anon`/`authenticated`
  have no grants on it.
- Two narrow `SECURITY DEFINER` functions resolve a share-link or invitation token hash to a
  workspace id, the only cross-tenant lookups in the system.
- Background jobs carry their `workspace_id` and run under that context.
- **Accounting firms (Phase 2):** `WorkspaceGuard` grants the `accountant` role when the user belongs to the firm
  linked to the workspace. RLS lets firm members *list* their firm's workspaces (`ws_select` uses
  `app.user_firm_ids()`, a `SECURITY DEFINER` helper that avoids recursive policies); every other table is still keyed
  on the single workspace the guard sets. Firm invitations are accepted inside `app.accept_firm_invitation`, which checks
  the token and the invitee's email together. Linking needs the client's owner/admin and the firm's code; the
  client can unlink at any time, which removes the firm's access immediately.

## 5. Data protection (NFR-6, NFR-9, NFR-12)

| Data | Protection |
|---|---|
| Bank account number, TOTP secret | AES-256-GCM, key from `DATA_ENCRYPTION_KEY` (versioned ciphertext `v1.` for rotation) |
| Sessions, OTPs, invitation and share tokens, recovery codes | Hashed (SHA-256 / HMAC-SHA-256); raw values never stored |
| OTP message bodies | Not written to the outbox (`[redacted]`) |
| Logs | pino with redaction of cookies, auth headers, OTP codes, identifiers, bank numbers |
| Personal data requests | `GET /v1/me/export`, `POST /v1/me/deletion-request` (deletion anonymises after review because tax records must be kept ≥ 6 years) |

**Signing keys (NFR-6, HSM):** invoice signing happens at the Access Point Provider. Supabase and
Vercel have no HSM, so if we become our own APP, keys must live in a cloud KMS/HSM (e.g. AWS KMS or
GCP Cloud HSM) — an open Phase 4 decision tied to the "own APP vs partner" question.

## 6. Transport and headers

TLS 1.2+ terminates at Vercel/Supabase. API: Helmet with `default-src 'none'`, HSTS (2 years,
preload), `frame-ancestors 'none'`, no CORS (the web app proxies `/api/*` same-origin). Web: strict
CSP (no third-party origins), `X-Frame-Options: DENY`, `nosniff`, restrictive Permissions-Policy.

## 7. Secrets and supply chain

- Secrets only in Vercel/Supabase environment settings; `.env*` git-ignored; config validated at boot
  (bad or missing keys stop the deploy); console notification providers and `OTP_DEV_ECHO` are refused
  in production.
- CI: lockfile install, `pnpm audit --prod`, gitleaks secret scan, CodeQL, typecheck, tests against a
  real Postgres with RLS. Dependabot weekly.
- Annual third-party penetration test with critical findings fixed within 14 days (NFR-8).

## 8. Backups and recovery (NFR-13)

Supabase Pro with Point-in-Time Recovery gives RPO ≤ 15 min (WAL archiving every 2 min). RTO ≤ 4 h
via PITR restore to a new project + DNS switch. A daily restore test runs against a scratch project
(runbook: `docs/runbooks/restore.md`, to be written in Phase 4).

## 9. Known gaps (tracked)

- Real APP integration, NRS/NITDA certification and signing-key custody (Phase 4).
- WhatsApp Business API and SMS delivery are stubbed (console provider) — WhatsApp uses click-to-chat links.
- Field-level encryption key is a single env key; move to envelope encryption with a KMS-held KEK before launch.
- Rate limiting is per fixed window; add an IP reputation / bot check on OTP request if SMS pumping is seen.
