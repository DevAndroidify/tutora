import {
  Controller,
  Get,
  Global,
  Header,
  Injectable,
  Module,
  NestMiddleware,
  Req,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { AppConfig } from '../config/app-config';
import { InjectDb, type Database } from '../database/database.module';
import { AppError } from '../errors/app-error';
import { Public } from '../http/route-metadata';

/**
 * Prometheus metrics. One registry per app instance (so tests can boot several apps).
 * Business metrics are computed from PostgreSQL at scrape time: Postgres is the source of truth,
 * and the numbers are the same no matter which API or worker instance is scraped.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpDuration = new Histogram({
    name: 'tutora_http_request_duration_seconds',
    help: 'HTTP request duration by method, route and status.',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  /** Accept attempts refused because another accept already won (double booking prevented). */
  readonly acceptanceConflicts = new Counter({
    name: 'tutora_acceptance_conflicts_prevented_total',
    help: 'Bid accept attempts rejected with 409 because the request or bid was already taken.',
    registers: [this.registry],
  });

  constructor(@InjectDb() private readonly db: Database) {
    collectDefaultMetrics({ register: this.registry, prefix: 'tutora_' });
    const gauge = (
      name: string,
      help: string,
      collect: () => Promise<number | null>,
      labelNames: string[] = [],
    ) =>
      new Gauge({
        name,
        help,
        labelNames,
        registers: [this.registry],
        async collect() {
          const v = await collect().catch(() => null);
          if (v !== null && Number.isFinite(v)) this.set(v);
        },
      });

    const one = async (q: ReturnType<typeof sql>): Promise<number | null> => {
      const r = await this.db.execute<{ v: string | null }>(q);
      const v = r.rows[0]?.v;
      return v === null || v === undefined ? null : Number(v);
    };

    gauge(
      'tutora_bid_delivery_p95_seconds',
      'p95 time from a bid being saved to its realtime event being published (last hour).',
      () =>
        one(sql`select percentile_cont(0.95) within group (order by extract(epoch from published_at - created_at)) as v
                from outbox_events where event_type like 'bid.%' and published_at > now() - interval '1 hour'`),
    );
    gauge(
      'tutora_reconciliation_mismatches',
      'Ledger checks that fail: unbalanced transactions plus held_funds differing from held payments.',
      () =>
        one(sql`select (
          (select count(*) from (select transaction_id from ledger_entries group by transaction_id
             having sum(case when direction = 'DEBIT' then amount_paise else -amount_paise end) <> 0) u)
          + case when coalesce((select sum(case when e.direction = 'CREDIT' then e.amount_paise else -e.amount_paise end)
                 from ledger_entries e join ledger_accounts a on a.id = e.account_id where a.code = 'held_funds'), 0)
               = coalesce((select sum(coalesce(paid_amount_paise, amount_paise)) from payments
                 where status in ('HELD', 'FROZEN', 'VERIFIED')), 0) then 0 else 1 end) as v`),
    );
    gauge(
      'tutora_session_completion_ratio',
      'Share of sessions that reached ENDED among sessions that were due (30 days).',
      () =>
        one(sql`select case when count(*) = 0 then null else count(*) filter (where status = 'ENDED')::float / count(*) end as v
                from sessions where status in ('ENDED', 'NO_SHOW') and starts_at > now() - interval '30 days'`),
    );
    gauge(
      'tutora_tutor_no_show_rate',
      'Share of due sessions where the tutor never joined (30 days).',
      () =>
        one(sql`select case when count(*) = 0 then null else count(*) filter (where status = 'NO_SHOW')::float / count(*) end as v
                from sessions where status in ('ENDED', 'NO_SHOW') and starts_at > now() - interval '30 days'`),
    );
    gauge(
      'tutora_low_bandwidth_share',
      'Share of sessions reporting mode changes that used audio-only or whiteboard-only (30 days).',
      () =>
        one(sql`select case when count(distinct session_id) = 0 then null
                  else (count(distinct session_id) filter (where mode <> 'FULL_VIDEO'))::float / count(distinct session_id) end as v
                from session_mode_events where created_at > now() - interval '30 days'`),
    );
    gauge(
      'tutora_pool_invite_acceptance_ratio',
      'Accepted / answered pool invitations (30 days).',
      () =>
        one(sql`select case when count(*) = 0 then null else count(*) filter (where status = 'ACCEPTED')::float / count(*) end as v
                from pool_invites where status in ('ACCEPTED', 'DECLINED', 'EXPIRED') and created_at > now() - interval '30 days'`),
    );
    const database = this.db;
    new Gauge({
      name: 'tutora_quiz_pass_rate',
      help: 'Share of submitted quizzes passed, by kind (30 days).',
      labelNames: ['kind'],
      registers: [this.registry],
      async collect() {
        const rows = await database
          .execute<{ kind: string; v: string | null }>(
            sql`select kind, avg(case when passed then 1.0 else 0.0 end) as v from quiz_attempts
                where status = 'SUBMITTED' and submitted_at > now() - interval '30 days' group by kind`,
          )
          .catch(() => ({ rows: [] as Array<{ kind: string; v: string | null }> }));
        for (const r of rows.rows) if (r.v !== null) this.set({ kind: r.kind }, Number(r.v));
      },
    });
  }
}

@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const end = this.metrics.httpDuration.startTimer();
    res.on('finish', () => {
      const route = (req as Request & { route?: { path?: string } }).route?.path;
      end({
        method: req.method,
        route: route ? `${req.baseUrl}${route}` : 'unmatched',
        status: String(res.statusCode),
      });
    });
    next();
  }
}

@ApiExcludeController()
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly config: AppConfig,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(@Req() req: Request): Promise<string> {
    const token = this.config.env.METRICS_TOKEN;
    // In production metrics are off unless a scrape token is configured.
    if (!token && this.config.isProduction) throw AppError.notFound('NOT_FOUND', 'Not found.');
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      throw AppError.unauthorized('UNAUTHENTICATED', 'Metrics token required.');
    }
    return this.metrics.registry.metrics();
  }
}

@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, HttpMetricsMiddleware],
  exports: [MetricsService],
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpMetricsMiddleware).forRoutes('*path');
  }
}
