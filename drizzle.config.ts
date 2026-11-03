import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/modules/**/*.schema.ts',
    './src/platform/**/*.schema.ts',
    './src/providers/**/*.schema.ts',
  ],
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://tutora:tutora@localhost:5432/tutora',
  },
  strict: true,
  verbose: true,
});
