-- Payment idempotency and reconciliation.

-- A duplicate payment (two checkouts for the same period) is refunded instead of applied.
ALTER TABLE "payments" DROP CONSTRAINT "payments_status_valid";
ALTER TABLE "payments" ADD CONSTRAINT "payments_status_valid"
  CHECK ("status" IN ('pending','success','failed','abandoned','refund_pending','refunded','refund_failed'));
-- The hosted checkout link, so a second tab reuses the same payment instead of starting another.
ALTER TABLE "payments" ADD COLUMN "authorization_url" TEXT;
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");

-- Problems the reconciliation found that need a person (unknown references, amount mismatches,
-- payments missing at the gateway, refunds that failed).
CREATE TABLE "payment_discrepancies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference" TEXT NOT NULL,
    "workspace_id" UUID,
    "kind" TEXT NOT NULL,
    "detail" JSONB,
    "resolved_at" TIMESTAMPTZ(3),
    CONSTRAINT "payment_discrepancies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_discrepancies_reference_kind_key" ON "payment_discrepancies"("reference", "kind");
ALTER TABLE app.payment_discrepancies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON app.payment_discrepancies FOR SELECT TO app_runtime
  USING (workspace_id = app.current_workspace_id());
GRANT SELECT ON app.payment_discrepancies TO app_runtime;

-- System functions for the scheduled checks, which look across all workspaces. SECURITY DEFINER
-- with narrow inputs and outputs: no invoice or customer data, only payment references and status.

CREATE OR REPLACE FUNCTION app.stale_pending_payments(p_min_age_seconds int, p_limit int)
  RETURNS TABLE (reference text, workspace_id uuid, created_at timestamptz, status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $fn$
  SELECT p.reference, p.workspace_id, p.created_at, p.status FROM app.payments p
   WHERE p.status IN ('pending', 'refund_pending')
     AND p.created_at < now() - make_interval(secs => p_min_age_seconds)
   ORDER BY p.created_at
   LIMIT least(p_limit, 500)
$fn$;

CREATE OR REPLACE FUNCTION app.payments_by_reference(p_references text[])
  RETURNS TABLE (reference text, workspace_id uuid, status text, amount int)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $fn$
  SELECT p.reference, p.workspace_id, p.status, p.amount FROM app.payments p
   WHERE p.reference = ANY (p_references[1:1000])
$fn$;

CREATE OR REPLACE FUNCTION app.settled_payments_between(p_from timestamptz, p_to timestamptz)
  RETURNS TABLE (reference text, workspace_id uuid, amount int, paid_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $fn$
  SELECT p.reference, p.workspace_id, p.amount, p.paid_at FROM app.payments p
   WHERE p.status = 'success' AND p.paid_at >= p_from AND p.paid_at < p_to
   LIMIT 10000
$fn$;

CREATE OR REPLACE FUNCTION app.paid_workspaces_past_period_end(p_limit int)
  RETURNS TABLE (workspace_id uuid, current_period_end timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $fn$
  SELECT w.id, w.current_period_end FROM app.workspaces w
   WHERE w.plan IN ('starter', 'business', 'pro')
     AND w.current_period_end < now()
     AND w.current_period_end > now() - interval '8 days'
   LIMIT least(p_limit, 1000)
$fn$;

CREATE OR REPLACE FUNCTION app.record_payment_discrepancy(p_reference text, p_workspace uuid, p_kind text, p_detail jsonb)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = app, pg_temp AS $fn$
  INSERT INTO app.payment_discrepancies (reference, workspace_id, kind, detail)
  VALUES (left(p_reference, 128), p_workspace, left(p_kind, 64), p_detail)
  ON CONFLICT (reference, kind) DO NOTHING
$fn$;

CREATE OR REPLACE FUNCTION app.open_payment_discrepancies(p_since timestamptz)
  RETURNS TABLE (reference text, workspace_id uuid, kind text, detail jsonb, detected_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $fn$
  SELECT d.reference, d.workspace_id, d.kind, d.detail, d.detected_at FROM app.payment_discrepancies d
   WHERE d.resolved_at IS NULL AND d.detected_at >= p_since
   ORDER BY d.detected_at DESC LIMIT 500
$fn$;

REVOKE ALL ON FUNCTION app.stale_pending_payments(int, int), app.payments_by_reference(text[]),
  app.settled_payments_between(timestamptz, timestamptz), app.paid_workspaces_past_period_end(int),
  app.record_payment_discrepancy(text, uuid, text, jsonb), app.open_payment_discrepancies(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.stale_pending_payments(int, int), app.payments_by_reference(text[]),
  app.settled_payments_between(timestamptz, timestamptz), app.paid_workspaces_past_period_end(int),
  app.record_payment_discrepancy(text, uuid, text, jsonb), app.open_payment_discrepancies(timestamptz) TO app_runtime;
