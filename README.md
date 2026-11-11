# E-Invoice — SME e-invoicing and tax compliance (Nigeria)

Lets Nigerian SMEs and their accountants create invoices that the Nigeria Revenue Service (NRS) clears
through the Merchant Buyer Solution (MBS), without an ERP. Built from the FRD
"SME E-Invoicing and Tax Compliance Platform".

- **Architecture:** [docs/architecture.md](docs/architecture.md)
- **Security:** [docs/security.md](docs/security.md)

## What's in this build (Phases 0–1)

| Area | Stories |
|---|---|
| Sign-up/sign-in with OTP, optional TOTP 2FA, sessions | E1-1, NFR-7 |
| Business setup, Tax ID check, branding & bank, tax band, MBS connection wizard (sandbox → live) | E1-2 … E1-5 |
| Customers (TIN checks, duplicates), products (VAT treatment), CSV/XLSX import | E2-1 … E2-3 |
| Invoices: drafts with autosave, live VAT totals, pre-submission checks, one-click clearance, IRN + QR, PDF, share by WhatsApp/email/link, queue + retry when NRS is down | E3-1 … E3-7 |
| Credit and debit notes against an IRN | E4-1, E4-2 |
| Roles, invitations, approvals, append-only audit log | E9-1, E9-2 (+ approval groundwork for E6-3/E9-3) |

NRS MBS, the Tax ID registry, SMS and WhatsApp are behind interfaces with **mock/console
implementations** until the APP partnership and provider accounts exist.

## Run it locally

Requirements: Node 20+, pnpm 10, PostgreSQL 15+ running locally.

```bash
pnpm install
```

```bash
cp apps/api/.env.example apps/api/.env
```

Edit `apps/api/.env` and set **one** of:

- `SUPABASE_DB_URL` — your Supabase project's **Session pooler** string (Dashboard → Connect →
  Session pooler), with `[YOUR-PASSWORD]` replaced; or
- `ADMIN_DATABASE_URL` — a local Postgres superuser connection.

Then:

```bash
pnpm --filter @einv/shared build
```

```bash
pnpm --filter @einv/api db:setup
```

This applies the migrations (schema, RLS, triggers), gives the `app_runtime` role a generated
password, and writes the runtime connection (Supabase transaction pooler, as `app_runtime`) plus
generated secrets into `.env`. With local Postgres it also creates `einvoice_dev` and `einvoice_test`.

```bash
pnpm dev
```

Web: http://localhost:3000 · API: http://localhost:4000 · API docs (dev): http://localhost:4000/v1/docs

In development the OTP code is shown on the sign-in screen and printed in the API log.
Try Tax ID `12345678-0001` to see the registry-name mismatch warning; any other `########-####`
TIN is accepted. To exercise the retry queue, call `POST /v1/dev/mock-mbs/outage {"on": true}`.

## Tests

```bash
pnpm test
```

- `packages/shared`: VAT maths, roles, status machine, validation (Vitest).
- `apps/api`: unit tests plus end-to-end tests against the real test database with RLS — auth,
  CSRF, cross-tenant isolation, clearance, rejection → fix → resubmit, outage → retry with no
  duplicate IRN, cleared-invoice lock, credit/debit notes, roles/approvals, sharing, audit immutability.
  E2E tests are skipped if `TEST_DATABASE_URL` is not set.

## Repository layout

```
apps/api          NestJS API, Prisma schema + migrations, tests
apps/web          Next.js web app
packages/shared   Schemas, VAT calculator, roles, NRS error catalogue (used by both apps)
packages/config   Shared TypeScript config
docs/             Architecture and security
```
