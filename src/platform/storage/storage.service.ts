import { Global, Injectable, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppConfig } from '../config/app-config';

/**
 * S3-compatible object storage (MinIO locally). Buckets are private;
 * clients get short-lived presigned URLs.
 */
@Injectable()
export class StorageService implements OnApplicationShutdown {
  private readonly logger = new Logger(StorageService.name);
  readonly client: S3Client;
  readonly bucket: string;

  constructor(config: AppConfig) {
    const s = config.storage;
    this.bucket = s.bucket;
    this.client = new S3Client({
      endpoint: s.endpoint,
      region: s.region,
      forcePathStyle: s.forcePathStyle,
      credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 2_000, requestTimeout: 3_000 },
    });
  }

  /** Throws if the bucket is unreachable or missing. */
  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  /** Creates the private bucket if it does not exist. Used by setup scripts. */
  async ensureBucket(): Promise<void> {
    try {
      await this.ping();
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Created bucket ${this.bucket}`);
    }
  }

  /**
   * URL for a single PUT of exactly this content type and size. The signature covers
   * Content-Type and Content-Length, so the client cannot upload something else.
   */
  presignPut(
    key: string,
    contentType: string,
    sizeBytes: number,
    ttlSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: sizeBytes,
      }),
      { expiresIn: ttlSeconds, signableHeaders: new Set(['content-type', 'content-length']) },
    );
  }

  presignGet(key: string, ttlSeconds: number, downloadName?: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: downloadName
          ? `inline; filename="${downloadName.replace(/[^\w. -]/g, '_')}"`
          : undefined,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  /** Size and type of a stored object, or null if it does not exist. */
  async head(key: string): Promise<{ sizeBytes: number; contentType: string } | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: res.ContentLength ?? 0, contentType: res.ContentType ?? '' };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as { name?: string }).name === 'NotFound') return null;
      throw err;
    }
  }

  /** Reads a small text object, or null if missing. */
  async getText(key: string): Promise<string | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return (await res.Body?.transformToString('utf8')) ?? null;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as { name?: string }).name === 'NoSuchKey') return null;
      throw err;
    }
  }

  async putText(key: string, body: string, contentType = 'application/json'): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
