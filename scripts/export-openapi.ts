/**
 * Writes one OpenAPI document per client app to docs/openapi/ and checks them:
 * every operation has a summary, and every non-public route declares bearer auth.
 *   yarn openapi:export
 */
import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AdminAppModule } from '../src/apps/admin/admin-app.module';
import { PublicAppModule } from '../src/apps/public/public-app.module';
import { StudentAppModule } from '../src/apps/student/student-app.module';
import { TutorAppModule } from '../src/apps/tutor/tutor-app.module';
import { WebhooksAppModule } from '../src/apps/webhooks/webhooks-app.module';
import { ApiModule } from '../src/app/api.module';
import { HealthModule } from '../src/platform/health/health.controller';

const DOCS = [
  { name: 'student', title: 'Tutora Student API', include: [StudentAppModule] },
  { name: 'tutor', title: 'Tutora Tutor API', include: [TutorAppModule] },
  { name: 'admin', title: 'Tutora Admin API', include: [AdminAppModule] },
  {
    name: 'public',
    title: 'Tutora Public API',
    include: [PublicAppModule, HealthModule, WebhooksAppModule],
  },
];
const PUBLIC = [/^\/health/, /^\/public\//, /^\/webhooks\//, /\/auth\//];

async function main(): Promise<void> {
  const app = await NestFactory.create(ApiModule, { logger: ['error'] });
  const out = resolve(process.cwd(), 'docs/openapi');
  mkdirSync(out, { recursive: true });
  const problems: string[] = [];
  for (const d of DOCS) {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle(d.title).setVersion('1.0.0').addBearerAuth().build(),
      { include: d.include },
    );
    let ops = 0;
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(
        item as Record<string, { summary?: string; security?: unknown[] }>,
      )) {
        ops++;
        if (!op.summary) problems.push(`${d.name}: ${method.toUpperCase()} ${path} has no summary`);
        const isPublic = PUBLIC.some((p) => p.test(path));
        if (!isPublic && !(op.security ?? []).length)
          problems.push(`${d.name}: ${method.toUpperCase()} ${path} does not declare bearer auth`);
      }
    }
    writeFileSync(resolve(out, `${d.name}.json`), JSON.stringify(doc, null, 2));
    console.log(
      `${d.name.padEnd(8)} ${String(Object.keys(doc.paths).length).padStart(3)} paths, ${String(ops).padStart(3)} operations -> docs/openapi/${d.name}.json`,
    );
  }
  await app.close();
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(
    '\nOpenAPI review: every operation has a summary and every private route declares bearer auth.',
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
