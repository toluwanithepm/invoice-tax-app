-- Phase 3: subscriptions and billing (E10), approval threshold (E9-3).

ALTER TABLE "workspaces"
  ADD COLUMN "billing_interval" TEXT,
  ADD COLUMN "current_period_end" TIMESTAMPTZ(3),
  ADD COLUMN "auto_renew" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "next_plan" TEXT,
  ADD COLUMN "next_interval" TEXT,
  ADD COLUMN "billing_email" TEXT,
  ADD COLUMN "card_auth_enc" TEXT,
  ADD COLUMN "card_last4" TEXT,
  ADD COLUMN "card_brand" TEXT,
  ADD COLUMN "card_expiry" TEXT,
  ADD COLUMN "approval_threshold" DECIMAL(18,2);

-- Workspaces created before billing existed get a trial from their creation date.
UPDATE "workspaces" SET "trial_ends_at" = "created_at" + interval '14 days' WHERE "trial_ends_at" IS NULL;

CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "list_price" INTEGER NOT NULL,
    "credit" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "channel" TEXT,
    "failure_reason" TEXT,
    "period_start" TIMESTAMPTZ(3),
    "period_end" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "receipt_number" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "payments_status_valid" CHECK ("status" IN ('pending','success','failed','abandoned'))
);
CREATE UNIQUE INDEX "payments_reference_key" ON "payments"("reference");
CREATE UNIQUE INDEX "payments_receipt_number_key" ON "payments"("receipt_number");
CREATE INDEX "payments_workspace_id_created_at_idx" ON "payments"("workspace_id", "created_at");
ALTER TABLE "payments" ADD CONSTRAINT "payments_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE ON app.payments TO app_runtime;
ALTER TABLE app.payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.payments FOR ALL TO app_runtime
  USING (workspace_id = app.current_workspace_id())
  WITH CHECK (workspace_id = app.current_workspace_id());

-- A settled payment is a financial record: amount, plan and period never change afterwards.
CREATE OR REPLACE FUNCTION app.lock_settled_payments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'success' THEN
    RAISE EXCEPTION 'Settled payments cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_lock_settled BEFORE UPDATE ON app.payments
  FOR EACH ROW EXECUTE FUNCTION app.lock_settled_payments();

-- The payment gateway's webhook arrives with no session: find which workspace a reference belongs to.
CREATE OR REPLACE FUNCTION app.resolve_payment(p_reference text)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $fn$
  SELECT workspace_id FROM app.payments WHERE reference = p_reference
$fn$;
REVOKE ALL ON FUNCTION app.resolve_payment(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_payment(text) TO app_runtime;
