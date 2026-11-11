-- Security layer: runtime role, row-level security (NFR-14), immutability (NFR-11), audit (E9-2).
-- The API connects as app_runtime, which has no BYPASSRLS and owns nothing, so every tenant
-- query is filtered by the workspace set with set_config('app.workspace_id', …, true).

-- ── Runtime role ───────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

REVOKE ALL ON SCHEMA app FROM PUBLIC;
DO $$
BEGIN
  -- Supabase API roles must never reach this schema (the Data API only exposes "public").
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA app FROM anon, authenticated';
  END IF;
END $$;

GRANT USAGE ON SCHEMA app TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'app' AND tablename = '_prisma_migrations') THEN
    EXECUTE 'REVOKE ALL ON app._prisma_migrations FROM app_runtime';
  END IF;
END $$;

-- Audit log is append-only for the runtime role.
REVOKE UPDATE, DELETE, TRUNCATE ON app.audit_events FROM app_runtime;

-- ── Request context helpers ────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.current_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION app.current_workspace_id(), app.current_user_id() TO app_runtime;

-- ── Row-level security ─────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers','products','import_jobs','invoices','invoice_lines',
                           'clearance_attempts','share_links','share_events','invitations']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I FOR ALL TO app_runtime
         USING (workspace_id = app.current_workspace_id())
         WITH CHECK (workspace_id = app.current_workspace_id())', t);
  END LOOP;
END $$;

ALTER TABLE app.workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY ws_select ON app.workspaces FOR SELECT TO app_runtime USING (
  id = app.current_workspace_id()
  OR EXISTS (SELECT 1 FROM app.memberships m WHERE m.workspace_id = workspaces.id AND m.user_id = app.current_user_id())
);
CREATE POLICY ws_insert ON app.workspaces FOR INSERT TO app_runtime WITH CHECK (id = app.current_workspace_id());
CREATE POLICY ws_update ON app.workspaces FOR UPDATE TO app_runtime
  USING (id = app.current_workspace_id()) WITH CHECK (id = app.current_workspace_id());
-- No DELETE policy: workspaces are never hard-deleted by the app (retention, NFR-12).

ALTER TABLE app.memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY m_select ON app.memberships FOR SELECT TO app_runtime
  USING (user_id = app.current_user_id() OR workspace_id = app.current_workspace_id());
CREATE POLICY m_write ON app.memberships FOR INSERT TO app_runtime WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY m_update ON app.memberships FOR UPDATE TO app_runtime
  USING (workspace_id = app.current_workspace_id()) WITH CHECK (workspace_id = app.current_workspace_id());
CREATE POLICY m_delete ON app.memberships FOR DELETE TO app_runtime USING (workspace_id = app.current_workspace_id());

ALTER TABLE app.audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_select ON app.audit_events FOR SELECT TO app_runtime USING (workspace_id = app.current_workspace_id());
CREATE POLICY audit_insert ON app.audit_events FOR INSERT TO app_runtime
  WITH CHECK (workspace_id IS NULL OR workspace_id = app.current_workspace_id());

ALTER TABLE app.firm_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY fm_self ON app.firm_members FOR ALL TO app_runtime
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());
ALTER TABLE app.firms ENABLE ROW LEVEL SECURITY;
CREATE POLICY firm_member ON app.firms FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM app.firm_members fm WHERE fm.firm_id = firms.id AND fm.user_id = app.current_user_id()));

-- ── Immutability ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE: the audit log is append-only' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON app.audit_events
  FOR EACH ROW EXECUTE FUNCTION app.audit_append_only();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON app.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_append_only();

-- Cleared invoices and their lines cannot change (NFR-11): corrections go through credit/debit notes.
CREATE OR REPLACE FUNCTION app.lock_cleared_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'cleared' THEN
      RAISE EXCEPTION 'IMMUTABLE: cleared invoices cannot be changed' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'cleared' AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'IMMUTABLE: cleared invoices cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_lock BEFORE UPDATE OR DELETE ON app.invoices
  FOR EACH ROW EXECUTE FUNCTION app.lock_cleared_invoice();

CREATE OR REPLACE FUNCTION app.lock_cleared_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
  SELECT status INTO parent_status FROM app.invoices
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  IF parent_status = 'cleared' THEN
    RAISE EXCEPTION 'IMMUTABLE: cleared invoices cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_lines_lock BEFORE INSERT OR UPDATE OR DELETE ON app.invoice_lines
  FOR EACH ROW EXECUTE FUNCTION app.lock_cleared_lines();

-- ── Cross-tenant lookups by secret token (narrow, SECURITY DEFINER) ──
-- Public share links and invitations arrive without a workspace context. These functions
-- return only the ids needed to set that context; they take a SHA-256 token hash, never a raw token.
CREATE OR REPLACE FUNCTION app.resolve_share_token(p_token_hash text)
  RETURNS TABLE (share_link_id uuid, workspace_id uuid, invoice_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT s.id, s.workspace_id, s.invoice_id FROM app.share_links s
   WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL
     AND (s.expires_at IS NULL OR s.expires_at > now())
$$;
CREATE OR REPLACE FUNCTION app.resolve_invitation(p_token_hash text)
  RETURNS TABLE (invitation_id uuid, workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT i.id, i.workspace_id FROM app.invitations i
   WHERE i.token_hash = p_token_hash AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at > now()
$$;
REVOKE ALL ON FUNCTION app.resolve_share_token(text), app.resolve_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_share_token(text), app.resolve_invitation(text) TO app_runtime;

-- Money columns must never be negative.
ALTER TABLE app.invoices ADD CONSTRAINT invoices_totals_nonneg
  CHECK (subtotal >= 0 AND discount_total >= 0 AND vat_total >= 0 AND total >= 0);
ALTER TABLE app.invoices ADD CONSTRAINT invoices_doc_type_chk CHECK (doc_type IN ('invoice','credit_note','debit_note'));
ALTER TABLE app.invoices ADD CONSTRAINT invoices_status_chk
  CHECK (status IN ('draft','pending_approval','submitting','queued','cleared','rejected','failed'));
ALTER TABLE app.memberships ADD CONSTRAINT memberships_role_chk
  CHECK (role IN ('owner','admin','clerk','approver','viewer','accountant'));
ALTER TABLE app.products ADD CONSTRAINT products_vat_chk CHECK (vat_treatment IN ('standard','zero','exempt'));
ALTER TABLE app.invoice_lines ADD CONSTRAINT lines_vat_chk CHECK (vat_treatment IN ('standard','zero','exempt'));
