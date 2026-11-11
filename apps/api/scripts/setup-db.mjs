#!/usr/bin/env node
// Database bootstrap. Two modes, chosen by what is set in apps/api/.env:
//
//  Supabase (SUPABASE_DB_URL) — the "Session pooler" connection string from the Supabase dashboard
//    (Connect → Session pooler), user postgres.<project-ref>, port 5432. The script migrates that
//    database as the owner, gives the app_runtime role a generated password, and writes:
//      DIRECT_URL   = session pooler as postgres     (migrations only)
//      DATABASE_URL = transaction pooler (port 6543) as app_runtime.<project-ref>, pgbouncer mode (runtime, RLS enforced)
//    Tests use TEST_SUPABASE_DB_URL (a second project) if set, otherwise the same project with random data.
//
//  Local Postgres (ADMIN_DATABASE_URL) — a superuser connection. Creates einvoice_dev and einvoice_test.
//
// Both modes also generate SESSION_SECRET, DATA_ENCRYPTION_KEY and CRON_SECRET if missing.
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');

function readEnv() {
  if (!existsSync(envPath)) return {};
  return Object.fromEntries(
    readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/\s+#.*$/, '').replace(/^"|"$/g, '')];
      }),
  );
}
function upsertEnv(values) {
  let text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}="${v}"`;
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : text.replace(/\n?$/, '\n') + line + '\n';
  }
  writeFileSync(envPath, text);
}
const withParams = (base, params, mutate = () => {}) => {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  mutate(u);
  return u.toString();
};
const migrate = (ownerUrl, label) => {
  console.log(`migrating ${label} …`);
  execSync('npx prisma migrate deploy', {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: ownerUrl, DIRECT_URL: ownerUrl },
  });
};
async function setRuntimePassword(ownerUrl, password, ssl) {
  const c = new pg.Client({ connectionString: ownerUrl, ssl });
  await c.connect();
  await c.query(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${password.replace(/'/g, "''")}'`);
  await c.end();
}

const env = { ...readEnv(), ...process.env };
const password = env.APP_RUNTIME_PASSWORD || randomBytes(24).toString('base64url');
const secret = (key, bytes = 32) => env[key] || randomBytes(bytes).toString('base64');
const out = {
  SESSION_SECRET: secret('SESSION_SECRET'),
  DATA_ENCRYPTION_KEY: secret('DATA_ENCRYPTION_KEY'),
  CRON_SECRET: secret('CRON_SECRET', 24),
  APP_RUNTIME_PASSWORD: password,
};

if (env.SUPABASE_DB_URL && !env.SUPABASE_DB_URL.includes('[YOUR-PASSWORD]')) {
  // ── Supabase ─────────────────────────────────────────────────────
  const ssl = { rejectUnauthorized: false }; // Supabase pooler presents its own CA chain
  const prepare = async (sessionUrl, label) => {
    const u = new URL(sessionUrl);
    const ref = decodeURIComponent(u.username).split('.')[1];
    if (!ref || !u.hostname.includes('pooler.supabase.com')) {
      throw new Error(`${label}: use the "Session pooler" string (user postgres.<project-ref>, host *.pooler.supabase.com).`);
    }
    const owner = withParams(sessionUrl, { schema: 'app', sslmode: 'require' }, (x) => (x.port = '5432'));
    migrate(owner, label);
    await setRuntimePassword(withParams(sessionUrl, {}, (x) => (x.port = '5432')), password, ssl);
    const runtime = withParams(owner, { pgbouncer: 'true', connection_limit: '5' }, (x) => {
      x.port = '6543';
      x.username = `app_runtime.${ref}`;
      x.password = password;
    });
    return { owner, runtime };
  };
  const dev = await prepare(env.SUPABASE_DB_URL, 'Supabase project');
  const test = env.TEST_SUPABASE_DB_URL ? await prepare(env.TEST_SUPABASE_DB_URL, 'Supabase test project') : dev;
  if (test === dev) console.log('Note: tests will use the same Supabase project (they create their own random workspaces).');
  upsertEnv({ ...out, DATABASE_URL: dev.runtime, DIRECT_URL: dev.owner, TEST_DATABASE_URL: test.runtime, TEST_DIRECT_URL: test.owner });
} else if (env.ADMIN_DATABASE_URL && !env.ADMIN_DATABASE_URL.includes('<password>')) {
  // ── Local Postgres ───────────────────────────────────────────────
  const adminUrl = env.ADMIN_DATABASE_URL;
  const dbUrl = (database, params = {}) => withParams(adminUrl, params, (u) => (u.pathname = '/' + database));
  const DEV_DB = env.DEV_DB_NAME || 'einvoice_dev';
  const TEST_DB = env.TEST_DB_NAME || 'einvoice_test';
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  for (const name of [DEV_DB, TEST_DB]) {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) {
      await admin.query(`CREATE DATABASE "${name}"`);
      console.log(`created database ${name}`);
    }
  }
  await admin.end();
  for (const name of [DEV_DB, TEST_DB]) migrate(dbUrl(name, { schema: 'app' }), name);
  await setRuntimePassword(adminUrl, password, undefined);
  const runtime = (name) =>
    withParams(dbUrl(name, { schema: 'app' }), {}, (u) => {
      u.username = 'app_runtime';
      u.password = password;
    });
  upsertEnv({
    ...out,
    DATABASE_URL: runtime(DEV_DB),
    DIRECT_URL: dbUrl(DEV_DB, { schema: 'app' }),
    TEST_DATABASE_URL: runtime(TEST_DB),
    TEST_DIRECT_URL: dbUrl(TEST_DB, { schema: 'app' }),
  });
} else {
  console.error('Set SUPABASE_DB_URL (or ADMIN_DATABASE_URL for local Postgres) in apps/api/.env first. See .env.example.');
  process.exit(1);
}
console.log('Done. apps/api/.env now holds the runtime (app_runtime) and owner connection strings.');
