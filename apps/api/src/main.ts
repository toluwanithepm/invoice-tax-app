import { config } from 'dotenv';
// This project's .env wins over machine-level variables (e.g. a global DATABASE_URL for another project).
config({ quiet: true, override: true });
import { createApp } from './bootstrap';
import { env } from './config/env';

async function main() {
  const app = await createApp();
  await app.listen(env().PORT);
}

void main();
