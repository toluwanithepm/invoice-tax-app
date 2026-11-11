-- Raw SQL in the API is schema-qualified, but pooled connections (Supabase transaction pooler)
-- don't carry a session search_path. Setting it on the role makes every new backend session
-- for app_runtime resolve unqualified names in "app" first.
ALTER ROLE app_runtime SET search_path = app, public;
