# Architecture

## Overview

```
Browser ──HTTPS──▶ Vercel: Next.js web (apps/web)
                     │  /api/*  same-origin rewrite (cookies stay first-party)
                     ▼
                   Vercel: NestJS API (apps/api) ──Prisma (app_runtime, RLS)──▶ Supabase Postgres (schema app)
                     │                                                              ▲
                     │ AccessPointProvider (mock now, real APP later) ──▶ NRS MBS   │ pg_cron + pg_net
                     │ Notifications (Resend email, Termii SMS)                     │ every minute
                     └◀─────────── POST /internal/jobs/run (Bearer CRON_SECRET) ────┘
```

| Layer | Choice | Why |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | One lockfile, shared types/schemas, cached builds |
| Shared | `packages/shared` (zod schemas, VAT maths, roles, NRS error catalogue, status machine) | Browser and server compute identical totals and validation messages |
| API | NestJS 11 on Express | Module per bounded context, guards for auth/tenancy, DI for provider seams |
| Web | Next.js 15 App Router, Tailwind 4, Radix primitives, TanStack Query | Accessible components, small shell, no third-party runtime calls |
| DB | Postgres (Supabase) via Prisma 6 | RLS for tenant isolation; triggers for immutability |
| Jobs | Postgres `jobs` table, `FOR UPDATE SKIP LOCKED` | Serverless-friendly retry queue with no Redis |

## Modules (apps/api/src)

| Module | Stories | Notes |
|---|---|---|
| `auth` | E1-1, NFR-7 | OTP, sessions, TOTP, `/v1/me`, privacy export/deletion |
| `tenancy` | NFR-14 | `WorkspaceGuard` |
| `workspaces` | E1-2…E1-5 | Create + TIN verify, branding/bank (encrypted), MBS wizard, dashboard summary, audit API |
| `members` | E9-1 | Invitations, roles, last-owner protection |
| `customers`, `products` | E2-1, E2-2 | Duplicate TIN flag, buyer TIN lookup, VAT treatment required |
| `imports` | E2-3 | CSV/XLSX, header mapping, dry run with row errors, ≤ 5,000 rows |
| `invoices` | E3-1, E4 | Drafts with server-side totals, credit/debit notes with remaining-credit checks |
| `clearance` | E3-2, E3-3, E3-5, E3-7 | Validation, status machine, idempotent submission, retry with backoff for 72 h, approvals |
| `access-point` | E1-3 | `AccessPointProvider` + `TaxIdRegistry` interfaces; mock implementations; UBL 2.1 builder |
| `documents` | E3-4 | PDF (pdfkit) with IRN + QR, draft watermark |
| `sharing` | E3-6 | Share tokens, public view/PDF/logo, events, WhatsApp click-to-chat, email |
| `platform` | E9-2 | Audit writer, notifications outbox, rate limiter |
| `jobs` | NFR-4 | Queue, drain endpoint, health, dev tools |
| `reports` | E7-1, E7-2, E7-3 | Monthly VAT reconciliation vs the filed figure, Excel/PDF exports from the same data, sales/outstanding dashboard, mark paid |
| `b2c` | E5-1, E5-2, E5-3 | POS upload (CSV/XLSX, day-first dates, VAT-inclusive amounts), daily reports, auto-submit after the day closes, "no sales", retry, deadline alerts |
| `firms` | E6-1, E6-2, E6-3, E6-4 | Accounting firms, firm-level client access, cross-client dashboard (one SQL function), firm invitations, client connect codes, firm bill |

## Invoice lifecycle

```
draft ──submit──▶ [approvals on & not approver] ──▶ pending_approval ──approve──┐
  ▲                                                                              ▼
  └──edit── rejected ◀──MBS rejects── submitting ──MBS clears──▶ cleared (immutable)
                                         │
                                MBS/APP unreachable
                                         ▼
                                      queued ──retry (30s, 1m, 2m … ≤30m)──▶ submitting
                                         │ after 72 h
                                         ▼
                                       failed ──resubmit──▶ submitting
```

Numbers (`INV-000001`, `CN-…`, `DN-…`) are assigned at first submission, so drafts that are deleted
never leave gaps. Seller and buyer details are frozen into the invoice at submission.

## Deploying on Supabase + Vercel

1. **Supabase:** create a project (Pro plan for PITR). Run migrations with the direct (owner)
   connection: `DIRECT_URL=… DATABASE_URL=… pnpm --filter @einv/api db:migrate`. Then give the
   runtime role a password: `ALTER ROLE app_runtime WITH LOGIN PASSWORD '…';`.
   Runtime `DATABASE_URL` = pooled connection as `app_runtime` with `?pgbouncer=true&schema=app`.
2. **Vercel – API project** (root `apps/api`, framework NestJS): set the env vars from
   `apps/api/.env.example` with `NODE_ENV=production`, `JOBS_INPROCESS=false`, real email/SMS providers.
3. **Vercel – web project** (root `apps/web`): `API_URL` = the API deployment URL. Put both behind
   one domain (e.g. `app.example.ng`) so `WEB_ORIGIN`/`PUBLIC_APP_URL` match.
4. **Job drain:** in Supabase SQL, schedule
   `select cron.schedule('drain-jobs', '* * * * *', $$ select net.http_post(url := 'https://api…/internal/jobs/run', headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>')) $$);`
   (or add a Vercel Cron to `GET /internal/jobs/run` — Vercel sends `Authorization: Bearer $CRON_SECRET`).

## Phase plan

| Phase | Scope | Status |
|---|---|---|
| 0 Foundation | Monorepo, schema, RLS, auth, tenancy, RBAC, audit, jobs, CI | Built |
| 1 Core slice | E1, E2, E3-1…E3-7, E4, E9-1/E9-2 | Built |
| 2 Compliance ops | E5 B2C reporting, E6 firm workspace + dashboard, E7 reconciliation/exports | Built |
| 3 Monetisation | E10 billing (Paystack/Flutterwave), E9-3 threshold approvals, E8 inbound IRN check | — |
| 4 Go-live | Real APP adapter + certification, WhatsApp Business API, SMS, load test, pen test, KMS | — |

## B2C daily cycle (E5)

```
sales uploaded for day D ──▶ report(D) pending ──(00:30 Lagos, D+1)──▶ b2c.submit job ──▶ accepted | rejected | retry every 10 min
                                                             deadline: 23:59:59 Lagos on D+1
daily check job at deadline − 6 h ──▶ submits anything waiting ──▶ alerts owners/admins/accountants (email + SMS) if D isn't accepted
                                    └─▶ schedules the check for D+1 (chain stops when B2C is turned off)
```

Amounts from POS systems include VAT; `splitGross` works back to net and VAT in kobo so net + VAT always equals what the customer paid.
WhatsApp alerts (FRD E5-3) use SMS until the WhatsApp Business API provider is added in Phase 4.

## Firm access (E6)

A firm member opens any workspace whose `firm_id` is their firm, with the **accountant** role (direct membership,
if any, takes precedence). Clients link an existing workspace by entering the firm's 8-character code and can unlink
at any time; a firm can also create a client workspace and invite the business owner. The cross-client dashboard is a
single `SECURITY DEFINER` function (`app.firm_dashboard`) that first checks the caller belongs to the firm.
