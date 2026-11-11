/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  transform: {
    '^.+\.ts$': ['@swc/jest', { jsc: { parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true }, target: 'es2022' } }],
  },
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testTimeout: 180000, // e2e runs against a remote Postgres (Supabase) with real network latency
};
