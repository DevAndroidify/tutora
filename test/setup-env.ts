// Runs in every Jest worker before tests: point everything at the test database and Redis DB 1.
process.env.NODE_ENV = 'test';
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../src/platform/config/app-config').loadEnvFiles();
