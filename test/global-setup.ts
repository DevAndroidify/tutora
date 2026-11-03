import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { loadAppConfig } from '../src/platform/config/app-config';
import { runMigrations } from '../src/platform/database/migrate';

/** Once per test run: migrate the test database and make sure the test bucket exists. */
export default async function globalSetup(): Promise<void> {
  process.env.NODE_ENV = 'test';
  const config = loadAppConfig();
  if (!config.database.url.includes('_test')) {
    throw new Error(`Refusing to run tests against non-test database ${config.database.url}`);
  }
  await runMigrations(config.database.url);

  const s = config.storage;
  const s3 = new S3Client({
    endpoint: s.endpoint,
    region: s.region,
    forcePathStyle: s.forcePathStyle,
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
  });
  try {
    await s3.send(new HeadBucketCommand({ Bucket: s.bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: s.bucket }));
  } finally {
    s3.destroy();
  }
}
