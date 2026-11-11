-- Name of the firm linked to the current workspace, readable by that workspace's members
-- (they are not firm members, so RLS on app.firms would hide it).
CREATE OR REPLACE FUNCTION app.linked_firm(p_workspace uuid)
  RETURNS TABLE (firm_id uuid, firm_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $fn$
  SELECT f.id, f.name
    FROM app.workspaces w JOIN app.firms f ON f.id = w.firm_id
   WHERE w.id = p_workspace
     AND (EXISTS (SELECT 1 FROM app.memberships m WHERE m.workspace_id = w.id AND m.user_id = app.current_user_id())
          OR f.id IN (SELECT app.user_firm_ids()))
$fn$;
REVOKE ALL ON FUNCTION app.linked_firm(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.linked_firm(uuid) TO app_runtime;
