import { randomUUID } from 'node:crypto';
import { Global, Injectable, Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { Clock } from '../clock/clock';
import { AppError } from '../errors/app-error';
import { StorageService } from './storage.service';

export type UploadPurpose = 'REQUEST_ATTACHMENT' | 'BID_MEDIA' | 'WHITEBOARD';

const PURPOSES: Record<UploadPurpose, { types: Record<string, string>; maxBytes?: number }> = {
  REQUEST_ATTACHMENT: {
    types: {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'application/pdf': 'pdf',
    },
  },
  /** Short (about 30 seconds) intro video or audio for a bid. */
  BID_MEDIA: {
    types: {
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/webm': 'weba',
    },
    maxBytes: 25 * 1024 * 1024,
  },
  /** Low-bandwidth mode: whiteboard images instead of video (Part 17). */
  WHITEBOARD: {
    types: { 'image/png': 'png', 'image/webp': 'webp' },
    maxBytes: 2 * 1024 * 1024,
  },
};

export interface PresignedUpload {
  objectKey: string;
  uploadUrl: string;
  method: 'PUT';
  /** The client must send exactly these headers with the PUT. */
  headers: Record<string, string>;
  expiresAt: string;
}

export interface VerifiedUpload {
  objectKey: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * Presigned direct-to-storage uploads with type and size checks.
 * Keys are namespaced per user and purpose so ownership can be checked from the key.
 */
@Injectable()
export class UploadsService {
  constructor(
    private readonly storage: StorageService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  maxBytes(purpose: UploadPurpose): number {
    return PURPOSES[purpose].maxBytes ?? this.config.env.UPLOAD_MAX_BYTES;
  }

  async presign(
    userId: string,
    purpose: UploadPurpose,
    input: { contentType: string; sizeBytes: number },
  ): Promise<PresignedUpload> {
    const ext = PURPOSES[purpose].types[input.contentType];
    if (!ext) {
      throw AppError.badRequest('UNSUPPORTED_FILE_TYPE', 'This file type is not allowed.', {
        allowed: Object.keys(PURPOSES[purpose].types),
      });
    }
    const max = this.maxBytes(purpose);
    if (input.sizeBytes <= 0 || input.sizeBytes > max) {
      throw AppError.badRequest(
        'FILE_TOO_LARGE',
        `Files must be between 1 byte and ${max} bytes.`,
        {
          maxBytes: max,
        },
      );
    }
    const ttl = this.config.env.UPLOAD_URL_TTL_SECONDS;
    const objectKey = `${this.prefix(userId, purpose)}${randomUUID()}.${ext}`;
    return {
      objectKey,
      uploadUrl: await this.storage.presignPut(objectKey, input.contentType, input.sizeBytes, ttl),
      method: 'PUT',
      headers: { 'Content-Type': input.contentType, 'Content-Length': String(input.sizeBytes) },
      expiresAt: new Date(this.clock.nowMs() + ttl * 1000).toISOString(),
    };
  }

  /** Confirms the object exists, belongs to this user and purpose, and passes type/size checks. */
  async verify(userId: string, purpose: UploadPurpose, objectKey: string): Promise<VerifiedUpload> {
    if (!objectKey.startsWith(this.prefix(userId, purpose)) || objectKey.includes('..')) {
      throw AppError.forbidden('NOT_YOUR_UPLOAD', 'This upload does not belong to you.');
    }
    const head = await this.storage.head(objectKey);
    if (!head) {
      throw AppError.badRequest('UPLOAD_NOT_FOUND', 'Upload the file before attaching it.');
    }
    if (!PURPOSES[purpose].types[head.contentType] || head.sizeBytes > this.maxBytes(purpose)) {
      throw AppError.badRequest('INVALID_UPLOAD', 'The uploaded file type or size is not allowed.');
    }
    return { objectKey, contentType: head.contentType, sizeBytes: head.sizeBytes };
  }

  /** Short-lived read URL. Callers must check access first. */
  readUrl(objectKey: string, fileName?: string): Promise<string> {
    return this.storage.presignGet(objectKey, this.config.env.UPLOAD_URL_TTL_SECONDS, fileName);
  }

  private prefix(userId: string, purpose: UploadPurpose): string {
    return `uploads/${purpose.toLowerCase()}/${userId}/`;
  }
}

@Global()
@Module({
  providers: [UploadsService],
  exports: [UploadsService],
})
export class UploadsModule {}
