-- AlterTable
ALTER TABLE "firms" ADD COLUMN     "connect_code" TEXT NOT NULL,
ADD COLUMN     "created_by" UUID NOT NULL,
ADD COLUMN     "per_client_price" INTEGER NOT NULL DEFAULT 4000;

-- AlterTable
ALTER TABLE "firm_members" ADD COLUMN     "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "b2c_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "firm_linked_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "paid_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "firm_invitations" (
    "id" UUID NOT NULL,
    "firm_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "firm_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vat_declarations" (
    "workspace_id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "declared_vat" DECIMAL(18,2) NOT NULL,
    "note" TEXT,
    "declared_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vat_declarations_pkey" PRIMARY KEY ("workspace_id","month")
);

-- CreateTable
CREATE TABLE "b2c_reports" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "sales_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "no_sales" BOOLEAN NOT NULL DEFAULT false,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "net_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "vat_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "gross_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "deadline_at" TIMESTAMPTZ(3) NOT NULL,
    "report_ref" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_errors" JSONB,
    "submitted_at" TIMESTAMPTZ(3),
    "accepted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "b2c_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "b2c_sales" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "receipt_no" TEXT NOT NULL,
    "description" TEXT,
    "gross_amount" DECIMAL(18,2) NOT NULL,
    "vat_treatment" TEXT NOT NULL,
    "net" DECIMAL(18,2) NOT NULL,
    "vat" DECIMAL(18,2) NOT NULL,
    "buyer_name" TEXT,
    "buyer_phone" TEXT,

    CONSTRAINT "b2c_sales_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "firm_invitations_token_hash_key" ON "firm_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "firm_invitations_firm_id_idx" ON "firm_invitations"("firm_id");

-- CreateIndex
CREATE UNIQUE INDEX "b2c_reports_workspace_id_sales_date_key" ON "b2c_reports"("workspace_id", "sales_date");

-- CreateIndex
CREATE UNIQUE INDEX "b2c_sales_report_id_receipt_no_key" ON "b2c_sales"("report_id", "receipt_no");

-- CreateIndex
CREATE UNIQUE INDEX "firms_connect_code_key" ON "firms"("connect_code");

-- CreateIndex
CREATE INDEX "firm_members_user_id_idx" ON "firm_members"("user_id");

-- CreateIndex
CREATE INDEX "workspaces_firm_id_idx" ON "workspaces"("firm_id");

-- AddForeignKey
ALTER TABLE "firm_invitations" ADD CONSTRAINT "firm_invitations_firm_id_fkey" FOREIGN KEY ("firm_id") REFERENCES "firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vat_declarations" ADD CONSTRAINT "vat_declarations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2c_reports" ADD CONSTRAINT "b2c_reports_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "b2c_sales" ADD CONSTRAINT "b2c_sales_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "b2c_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ════════════════════════════════════════════════════════════════════
-- Phase 2 security: RLS for new tables, firm-level access (E6), paid date (E7-3)
-- ════════════════════════════════════════════════════════════════════

GRANT SELECT, INSERT, UPDATE, DELETE ON app.firm_invitations, app.vat_declarations, app.b2c_reports, app.b2c_sales TO app_runtime;

-- Tenant isolation for the new workspace-owned tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vat_declarations','b2c_reports','b2c_sales']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I FOR ALL TO app_runtime
         USING (workspace_id = app.current_workspace_id())
         WITH CHECK (workspace_id = app.current_workspace_id())', t);
  END LOOP;
END $$;

-- Firms the current user belongs to. SECURITY DEFINER so policies on firm_members can use it
-- without recursing into their own policy.
CREATE OR REPLACE FUNCTION app.user_firm_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT firm_id FROM app.firm_members WHERE user_id = app.current_user_id()
$$;
REVOKE ALL ON FUNCTION app.user_firm_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.user_firm_ids() TO app_runtime;

-- Firm members can list their firm's client workspaces (opening one still goes through
-- WorkspaceGuard, which sets app.workspace_id for every other table).
DROP POLICY ws_select ON app.workspaces;
CREATE POLICY ws_select ON app.workspaces FOR SELECT TO app_runtime USING (
  id = app.current_workspace_id()
  OR EXISTS (SELECT 1 FROM app.memberships m WHERE m.workspace_id = workspaces.id AND m.user_id = app.current_user_id())
  OR firm_id IN (SELECT app.user_firm_ids())
);

DROP POLICY firm_member ON app.firms;
CREATE POLICY firm_select ON app.firms FOR SELECT TO app_runtime
  USING (id IN (SELECT app.user_firm_ids()) OR created_by = app.current_user_id());
CREATE POLICY firm_insert ON app.firms FOR INSERT TO app_runtime WITH CHECK (created_by = app.current_user_id());
CREATE POLICY firm_update ON app.firms FOR UPDATE TO app_runtime
  USING (id IN (SELECT app.user_firm_ids())) WITH CHECK (id IN (SELECT app.user_firm_ids()));

DROP POLICY fm_self ON app.firm_members;
CREATE POLICY fm_select ON app.firm_members FOR SELECT TO app_runtime USING (firm_id IN (SELECT app.user_firm_ids()));
-- Insert: the creator adds themself when creating a firm; existing members add colleagues
-- (admin-only is enforced in the API). Joining by invitation goes through accept_firm_invitation().
CREATE POLICY fm_insert ON app.firm_members FOR INSERT TO app_runtime WITH CHECK (
  firm_id IN (SELECT app.user_firm_ids())
  OR EXISTS (SELECT 1 FROM app.firms f WHERE f.id = firm_id AND f.created_by = app.current_user_id())
);
CREATE POLICY fm_update ON app.firm_members FOR UPDATE TO app_runtime
  USING (firm_id IN (SELECT app.user_firm_ids())) WITH CHECK (firm_id IN (SELECT app.user_firm_ids()));
CREATE POLICY fm_delete ON app.firm_members FOR DELETE TO app_runtime USING (firm_id IN (SELECT app.user_firm_ids()));

ALTER TABLE app.firm_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY fi_all ON app.firm_invitations FOR ALL TO app_runtime
  USING (firm_id IN (SELECT app.user_firm_ids())) WITH CHECK (firm_id IN (SELECT app.user_firm_ids()));

-- Clients link their workspace to a firm by entering its connect code.
CREATE OR REPLACE FUNCTION app.resolve_firm_code(p_code text)
  RETURNS TABLE (firm_id uuid, firm_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT f.id, f.name FROM app.firms f WHERE f.connect_code = upper(trim(p_code))
$$;

CREATE OR REPLACE FUNCTION app.resolve_firm_invitation(p_token_hash text)
  RETURNS TABLE (invitation_id uuid, firm_id uuid, firm_name text, email text, role text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT i.id, i.firm_id, f.name, i.email, i.role FROM app.firm_invitations i JOIN app.firms f ON f.id = i.firm_id
   WHERE i.token_hash = p_token_hash AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at > now()
$$;

-- Accepting checks the token and the invitee's email in one place, then adds the membership.
CREATE OR REPLACE FUNCTION app.accept_firm_invitation(p_token_hash text, p_email text)
  RETURNS TABLE (firm_id uuid, role text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE inv record; uid uuid := app.current_user_id();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'FORBIDDEN: not signed in' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO inv FROM app.firm_invitations i
   WHERE i.token_hash = p_token_hash AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: invitation' USING ERRCODE = 'P0001'; END IF;
  IF lower(inv.email) <> lower(coalesce(p_email, '')) THEN
    RAISE EXCEPTION 'EMAIL_MISMATCH: %', inv.email USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO app.firm_members (firm_id, user_id, role) VALUES (inv.firm_id, uid, inv.role)
    ON CONFLICT ON CONSTRAINT firm_members_pkey DO NOTHING;
  UPDATE app.firm_invitations SET accepted_at = now() WHERE id = inv.id;
  RETURN QUERY SELECT inv.firm_id, inv.role;
END $$;

-- E6-2: one query for the cross-client compliance dashboard. Checks the caller is a firm member.
CREATE OR REPLACE FUNCTION app.firm_dashboard(p_firm uuid, p_today date)
  RETURNS TABLE (
    workspace_id uuid, legal_name text, trading_name text, tin text, mbs_status text, b2c_enabled boolean,
    drafts bigint, awaiting_approval bigint, in_progress bigint, needs_fixing bigint,
    cleared_this_month bigint, output_vat_this_month numeric, b2c_missing_days bigint, last_activity timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE month_start date := date_trunc('month', p_today)::date;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.firm_members fm WHERE fm.firm_id = p_firm AND fm.user_id = app.current_user_id()) THEN
    RAISE EXCEPTION 'FORBIDDEN: not a member of this firm' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT w.id, w.legal_name, w.trading_name, w.tin, w.mbs_status, w.b2c_enabled,
    count(i.id) FILTER (WHERE i.status = 'draft'),
    count(i.id) FILTER (WHERE i.status = 'pending_approval'),
    count(i.id) FILTER (WHERE i.status IN ('submitting','queued')),
    count(i.id) FILTER (WHERE i.status IN ('rejected','failed')),
    count(i.id) FILTER (WHERE i.status = 'cleared' AND i.issue_date >= month_start AND i.doc_type = 'invoice'),
    coalesce(sum(CASE WHEN i.status = 'cleared' AND i.issue_date >= month_start AND i.issue_date <= p_today
                      THEN CASE WHEN i.doc_type = 'credit_note' THEN -i.vat_total ELSE i.vat_total END END), 0)
      + coalesce((SELECT sum(r.vat_total) FROM app.b2c_reports r
                   WHERE r.workspace_id = w.id AND r.status = 'accepted' AND r.sales_date >= month_start), 0),
    CASE WHEN w.b2c_enabled THEN
      (SELECT count(*) FROM generate_series(p_today - 7, p_today - 1, interval '1 day') d
        WHERE d::date >= w.created_at::date
          AND NOT EXISTS (SELECT 1 FROM app.b2c_reports r
                           WHERE r.workspace_id = w.id AND r.sales_date = d::date AND r.status = 'accepted'))
    ELSE 0::bigint END,
    greatest(w.updated_at, max(i.updated_at))
  FROM app.workspaces w
  LEFT JOIN app.invoices i ON i.workspace_id = w.id
  WHERE w.firm_id = p_firm
  GROUP BY w.id
  ORDER BY w.legal_name;
END $$;

REVOKE ALL ON FUNCTION app.resolve_firm_code(text), app.resolve_firm_invitation(text),
  app.accept_firm_invitation(text, text), app.firm_dashboard(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_firm_code(text), app.resolve_firm_invitation(text),
  app.accept_firm_invitation(text, text), app.firm_dashboard(uuid, date) TO app_runtime;

-- Cleared invoices stay immutable except for the paid date (E7-3 outstanding payments).
CREATE OR REPLACE FUNCTION app.lock_cleared_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'cleared' THEN
      RAISE EXCEPTION 'IMMUTABLE: cleared invoices cannot be changed' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'cleared'
     AND (to_jsonb(NEW) - 'updated_at' - 'paid_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'paid_at') THEN
    RAISE EXCEPTION 'IMMUTABLE: cleared invoices cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE app.b2c_reports ADD CONSTRAINT b2c_status_chk CHECK (status IN ('pending','submitting','accepted','rejected','failed'));
ALTER TABLE app.b2c_sales ADD CONSTRAINT b2c_vat_chk CHECK (vat_treatment IN ('standard','zero','exempt'));
ALTER TABLE app.b2c_sales ADD CONSTRAINT b2c_amount_chk CHECK (gross_amount > 0 AND net >= 0 AND vat >= 0);
ALTER TABLE app.firm_members ADD CONSTRAINT firm_members_role_chk CHECK (role IN ('admin','accountant'));

-- Accepted B2C reports are final, like cleared invoices.
CREATE OR REPLACE FUNCTION app.lock_accepted_b2c() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'accepted' THEN
      RAISE EXCEPTION 'IMMUTABLE: accepted B2C reports cannot be changed' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'accepted' AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'IMMUTABLE: accepted B2C reports cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b2c_reports_lock BEFORE UPDATE OR DELETE ON app.b2c_reports
  FOR EACH ROW EXECUTE FUNCTION app.lock_accepted_b2c();

CREATE OR REPLACE FUNCTION app.lock_accepted_b2c_sales() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM app.b2c_reports
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.report_id ELSE NEW.report_id END;
  IF s = 'accepted' THEN
    RAISE EXCEPTION 'IMMUTABLE: accepted B2C reports cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b2c_sales_lock BEFORE INSERT OR UPDATE OR DELETE ON app.b2c_sales
  FOR EACH ROW EXECUTE FUNCTION app.lock_accepted_b2c_sales();
