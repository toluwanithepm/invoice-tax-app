// Runs before every test file. Points the app at the test database and fills safe test secrets.
import { config } from 'dotenv';
import { randomBytes } from 'crypto';
import { join } from 'path';

config({ path: join(__dirname, '..', '.env'), quiet: true, override: true });

process.env.NODE_ENV = 'test';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
if (process.env.TEST_DIRECT_URL) process.env.DIRECT_URL = process.env.TEST_DIRECT_URL;
process.env.SESSION_SECRET ||= randomBytes(32).toString('base64');
process.env.DATA_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
process.env.CRON_SECRET ||= randomBytes(24).toString('base64');
process.env.WEB_ORIGIN = 'http://localhost:3000';
process.env.PUBLIC_APP_URL = 'http://localhost:3000';
process.env.JOBS_INPROCESS = 'false';
process.env.OTP_DEV_ECHO = 'false';
process.env.EMAIL_PROVIDER = 'console';
process.env.SMS_PROVIDER = 'console';
