import { createHash } from 'node:crypto';
import {
  applyDecorators,
  CallHandler,
  ExecutionContext,
  Global,
  Injectable,
  Module,
  NestInterceptor,
  UseInterceptors,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { and, eq, lte } from 'drizzle-orm';
import type { Response } from 'express';
import { from, mergeMap, Observable, of, catchError, throwError } from 'rxjs';
import { AppConfig } from '../config/app-config';
import { Clock } from '../clock/clock';
import { InjectDb, type Database } from '../database/database.module';
import { AppError } from '../errors/app-error';
import type { AppRequest } from '../http/request-context';
import { idempotencyKeys } from './idempotency.schema';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const REPLAYED_HEADER = 'idempotent-replayed';
const KEY_FORMAT = /^[A-Za-z0-9_:.-]{8,255}$/;

/** Stable JSON: object keys sorted so `{a,b}` and `{b,a}` hash the same. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${canonicalJson(body)}`)
    .digest('hex');
}

/**
 * Makes a money-changing route safe to retry.
 *
 * - The `Idempotency-Key` header is required.
 * - The first request with a key runs and its response is saved.
 * - The same key with the same body returns the saved response (with `Idempotent-Replayed: true`).
 * - The same key with a different body returns 409 IDEMPOTENCY_KEY_REUSED.
 * - A key whose first request is still running returns 409 IDEMPOTENCY_REQUEST_IN_PROGRESS.
 * - If the handler throws, the key is released so the client can retry.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
    private readonly config: AppConfig,
  ) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<AppRequest>();
    const res = http.getResponse<Response>();

    const key = req.header(IDEMPOTENCY_HEADER);
    if (!key) {
      throw AppError.badRequest(
        'IDEMPOTENCY_KEY_REQUIRED',
        'This request needs an Idempotency-Key header.',
      );
    }
    if (!KEY_FORMAT.test(key)) {
      throw AppError.badRequest(
        'IDEMPOTENCY_KEY_INVALID',
        'Idempotency-Key must be 8-255 characters of letters, digits, "_", "-", ":" or ".".',
      );
    }

    const scope = req.user?.id ?? 'anon';
    const path = `${req.baseUrl}${req.path}`;
    const requestHash = hashRequest(req.method, path, req.body);

    const claimedId = await this.claim(scope, key, req.method, path, requestHash);
    if (!claimedId) {
      return of(await this.replay(scope, key, requestHash, res));
    }

    return next.handle().pipe(
      mergeMap((body: unknown) => from(this.complete(claimedId, res.statusCode, body))),
      catchError((err: unknown) =>
        from(this.release(claimedId)).pipe(mergeMap(() => throwError(() => err))),
      ),
    );
  }

  /** Inserts a new IN_PROGRESS row. Returns its id, or null if the key already exists. */
  private async claim(
    scope: string,
    key: string,
    method: string,
    path: string,
    requestHash: string,
  ): Promise<string | null> {
    const now = this.clock.now();
    const ttlMs = this.config.env.IDEMPOTENCY_TTL_HOURS * 3_600_000;

    // An expired key may be reused for a fresh request.
    await this.db
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.scope, scope),
          eq(idempotencyKeys.key, key),
          lte(idempotencyKeys.expiresAt, now),
        ),
      );

    const [row] = await this.db
      .insert(idempotencyKeys)
      .values({
        scope,
        key,
        method,
        path,
        requestHash,
        status: 'IN_PROGRESS',
        createdAt: now,
        expiresAt: new Date(now.getTime() + ttlMs),
      })
      .onConflictDoNothing({ target: [idempotencyKeys.scope, idempotencyKeys.key] })
      .returning({ id: idempotencyKeys.id });
    return row?.id ?? null;
  }

  private async replay(
    scope: string,
    key: string,
    requestHash: string,
    res: Response,
  ): Promise<unknown> {
    const [row] = await this.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));

    if (!row) {
      // The original request failed and released the key between our insert and select.
      throw AppError.conflict(
        'IDEMPOTENCY_REQUEST_IN_PROGRESS',
        'A request with this Idempotency-Key is being processed. Retry shortly.',
      );
    }
    if (row.requestHash !== requestHash) {
      throw AppError.conflict(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used with a different request.',
      );
    }
    if (row.status !== 'COMPLETED' || row.responseStatus === null) {
      throw AppError.conflict(
        'IDEMPOTENCY_REQUEST_IN_PROGRESS',
        'A request with this Idempotency-Key is being processed. Retry shortly.',
      );
    }

    res.status(row.responseStatus);
    res.setHeader(REPLAYED_HEADER, 'true');
    return row.responseBody ?? undefined;
  }

  private async complete(id: string, status: number, body: unknown): Promise<unknown> {
    await this.db
      .update(idempotencyKeys)
      .set({
        status: 'COMPLETED',
        responseStatus: status,
        responseBody: body === undefined ? null : body,
        completedAt: this.clock.now(),
      })
      .where(eq(idempotencyKeys.id, id));
    return body;
  }

  private async release(id: string): Promise<void> {
    await this.db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id));
  }
}

/** Requires an Idempotency-Key header and replays the first response for retries. */
export const Idempotent = (): MethodDecorator & ClassDecorator =>
  applyDecorators(
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description: 'Unique key per logical request (8-255 chars). Retries must reuse it.',
    }),
    UseInterceptors(IdempotencyInterceptor),
  );

@Global()
@Module({
  providers: [IdempotencyInterceptor],
  exports: [IdempotencyInterceptor],
})
export class IdempotencyModule {}
