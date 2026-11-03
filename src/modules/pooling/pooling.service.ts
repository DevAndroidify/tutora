import { Injectable, Logger, Module } from '@nestjs/common';
import { and, asc, count, eq, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { AppConfig } from '../../platform/config/app-config';
import { Clock } from '../../platform/clock/clock';
import { InjectDb, type Database, type DbExecutor } from '../../platform/database/database.module';
import { AppError } from '../../platform/errors/app-error';
import type { AuthUser } from '../../platform/http/request-context';
import { OutboxService, type OutboxEvent } from '../../platform/outbox/outbox.service';
import {
  EmbeddingProvider,
  FakeEmbeddingProvider,
} from '../../providers/embeddings/embedding.provider';
import { CatalogModule } from '../catalog/catalog.module';
import { CatalogService } from '../catalog/catalog.service';
import { RequestsModule } from '../requests/requests.module';
import { RequestsService } from '../requests/requests.service';
import { poolInvites, requestEmbeddings, requestPools, type PoolStatus } from './pooling.schema';

export interface MatchResult {
  poolId: string;
  matchedBy: 'EMBEDDING' | 'TOPIC';
  invited: string[];
}

/**
 * Part 18: finds learners with near-identical requests (same skill and level) and invites them into
 * a pool for a cheaper group session. Nobody is added automatically, and other learners' identities
 * and request text are never shown in invitations.
 */
@Injectable()
export class PoolingService {
  private readonly logger = new Logger(PoolingService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly requests: RequestsService,
    private readonly catalog: CatalogService,
    private readonly embeddings: EmbeddingProvider,
    private readonly outbox: OutboxService,
  ) {}

  /** Outbox consumer (worker): request.published -> embed + match. */
  async onEvent(event: OutboxEvent): Promise<void> {
    if (event.type === 'request.published')
      await this.processRequest(String(event.payload.requestId));
  }

  /** Embeds a published request (idempotent) and tries to pool it. */
  async processRequest(requestId: string): Promise<MatchResult | null> {
    await this.embed(requestId);
    return this.match(requestId);
  }

  async embed(requestId: string): Promise<void> {
    const req = await this.requests.find(requestId);
    if (!req || req.status !== 'OPEN') return;
    const [existing] = await this.db
      .select()
      .from(requestEmbeddings)
      .where(eq(requestEmbeddings.requestId, requestId));
    if (existing?.embedding) return;
    let embedding: number[] | null = null;
    let error: string | null = null;
    try {
      embedding = await this.embeddings.embed(`${req.title}\n${req.description}`);
    } catch (err) {
      error = err instanceof Error ? err.message.slice(0, 300) : 'embedding failed';
      this.logger.warn(
        { requestId, err },
        'Embedding failed; pooling falls back to the same topic',
      );
    }
    await this.db
      .insert(requestEmbeddings)
      .values({
        requestId,
        studentUserId: req.studentUserId,
        skillId: req.skillId,
        level: req.level,
        topicId: req.topicId,
        model: embedding ? this.embeddings.model : null,
        embedding,
        error,
        createdAt: this.clock.now(),
      })
      .onConflictDoUpdate({
        target: requestEmbeddings.requestId,
        set: { embedding, error, model: embedding ? this.embeddings.model : null },
      });
  }

  /** Invites similar open requests (same skill and level) into a forming pool. */
  async match(requestId: string): Promise<MatchResult | null> {
    const [me] = await this.db
      .select()
      .from(requestEmbeddings)
      .where(eq(requestEmbeddings.requestId, requestId));
    const req = await this.requests.find(requestId);
    if (!me || req?.status !== 'OPEN') return null;
    if (await this.activeInvite(requestId)) return null;

    const sameGroup = and(
      eq(requestEmbeddings.skillId, me.skillId),
      eq(requestEmbeddings.level, me.level),
      ne(requestEmbeddings.requestId, me.requestId),
      ne(requestEmbeddings.studentUserId, me.studentUserId),
    );
    let matchedBy: MatchResult['matchedBy'];
    let candidates: Array<{ requestId: string; studentUserId: string; similarity: number | null }>;

    if (me.embedding) {
      matchedBy = 'EMBEDDING';
      const vec = `[${me.embedding.join(',')}]`;
      const distance = sql<number>`(${requestEmbeddings.embedding} <=> ${vec}::vector)`;
      const rows = await this.db
        .select({
          requestId: requestEmbeddings.requestId,
          studentUserId: requestEmbeddings.studentUserId,
          distance,
        })
        .from(requestEmbeddings)
        .where(and(sameGroup, isNotNull(requestEmbeddings.embedding)))
        .orderBy(distance)
        .limit(20);
      candidates = rows
        .map((r) => ({
          requestId: r.requestId,
          studentUserId: r.studentUserId,
          similarity: 1 - Number(r.distance),
        }))
        .filter((r) => r.similarity >= this.config.env.POOL_SIMILARITY_THRESHOLD);
    } else {
      // Provider failed: fall back to requests on exactly the same topic.
      matchedBy = 'TOPIC';
      if (!me.topicId) return null;
      const rows = await this.db
        .select({
          requestId: requestEmbeddings.requestId,
          studentUserId: requestEmbeddings.studentUserId,
        })
        .from(requestEmbeddings)
        .where(and(sameGroup, eq(requestEmbeddings.topicId, me.topicId)))
        .orderBy(asc(requestEmbeddings.createdAt))
        .limit(20);
      candidates = rows.map((r) => ({ ...r, similarity: null }));
    }

    // Only requests that are still open and not already in another pool.
    const open = new Set(
      (await Promise.all(candidates.map((c) => this.requests.find(c.requestId))))
        .filter((r) => r?.status === 'OPEN')
        .map((r) => r!.id),
    );
    candidates = candidates.filter((c) => open.has(c.requestId));
    if (candidates.length === 0) return null;

    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.config.env.POOL_INVITE_TTL_HOURS * 3_600_000);
    return this.db.transaction(async (tx) => {
      // Join an existing forming pool that already invited one of the candidates, if it has room.
      const existing = await tx
        .select({ poolId: poolInvites.poolId })
        .from(poolInvites)
        .innerJoin(requestPools, eq(requestPools.id, poolInvites.poolId))
        .where(
          and(
            inArray(
              poolInvites.requestId,
              candidates.map((c) => c.requestId),
            ),
            inArray(poolInvites.status, ['INVITED', 'ACCEPTED']),
            eq(requestPools.status, 'FORMING'),
          ),
        )
        .limit(1);
      let poolId = existing[0]?.poolId;
      if (!poolId) {
        const [pool] = await tx
          .insert(requestPools)
          .values({
            skillId: me.skillId,
            level: me.level,
            seatCap: this.config.env.POOL_MAX_SEATS,
            createdAt: now,
            expiresAt,
          })
          .returning({ id: requestPools.id });
        poolId = pool!.id;
      }
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(poolInvites)
        .where(
          and(eq(poolInvites.poolId, poolId), inArray(poolInvites.status, ['INVITED', 'ACCEPTED'])),
        );
      let room = this.config.env.POOL_MAX_SEATS - n;
      const invited: string[] = [];
      for (const c of [
        {
          requestId: me.requestId,
          studentUserId: me.studentUserId,
          similarity: null as number | null,
        },
        ...candidates,
      ]) {
        if (room <= 0) break;
        const [row] = await tx
          .insert(poolInvites)
          .values({
            poolId,
            requestId: c.requestId,
            studentUserId: c.studentUserId,
            similarity: c.similarity,
            matchedBy,
            expiresAt,
            createdAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: poolInvites.id });
        if (row) {
          invited.push(c.requestId);
          room--;
          await this.outbox.add(tx, 'pool.invited', {
            poolId,
            inviteId: row.id,
            studentUserId: c.studentUserId,
          });
        }
      }
      return { poolId, matchedBy, invited };
    });
  }

  /** Invitations for this learner. Shows the pool, never the other learners. */
  async listInvites(student: AuthUser) {
    const rows = await this.db
      .select({ invite: poolInvites, pool: requestPools })
      .from(poolInvites)
      .innerJoin(requestPools, eq(requestPools.id, poolInvites.poolId))
      .where(
        and(
          eq(poolInvites.studentUserId, student.id),
          inArray(poolInvites.status, ['INVITED', 'ACCEPTED']),
        ),
      )
      .orderBy(asc(poolInvites.createdAt));
    const skills = await this.catalog.findSkills(rows.map((r) => r.pool.skillId));
    return Promise.all(
      rows.map(async ({ invite, pool }) => {
        const counts = await this.db
          .select({ status: poolInvites.status, n: count() })
          .from(poolInvites)
          .where(eq(poolInvites.poolId, pool.id))
          .groupBy(poolInvites.status);
        const c = (s: string) => counts.find((x) => x.status === s)?.n ?? 0;
        return {
          id: invite.id,
          status: invite.status,
          requestId: invite.requestId,
          expiresAt: invite.expiresAt.toISOString(),
          matchedBy: invite.matchedBy,
          similarity: invite.similarity,
          pool: {
            id: pool.id,
            status: pool.status,
            skill: { id: pool.skillId, name: skills.get(pool.skillId)?.name ?? '' },
            level: pool.level,
            seatCap: pool.seatCap,
            joined: c('ACCEPTED'),
            invited: c('INVITED'),
          },
        };
      }),
    );
  }

  /** INVITED -> ACCEPTED; the request becomes POOLED. */
  async accept(student: AuthUser, inviteId: string) {
    await this.db.transaction(async (tx) => {
      const [inv] = await tx
        .select()
        .from(poolInvites)
        .where(eq(poolInvites.id, inviteId))
        .for('update');
      if (!inv || inv.studentUserId !== student.id)
        throw AppError.notFound('INVITE_NOT_FOUND', 'Invitation not found.');
      if (inv.status !== 'INVITED')
        throw AppError.conflict('INVITE_NOT_OPEN', `This invitation is ${inv.status}.`);
      if (inv.expiresAt <= this.clock.now())
        throw AppError.conflict('INVITE_EXPIRED', 'This invitation has expired.');
      const [pool] = await tx
        .select()
        .from(requestPools)
        .where(eq(requestPools.id, inv.poolId))
        .for('update');
      if (pool?.status !== 'FORMING')
        throw AppError.conflict('POOL_CLOSED', 'This group is no longer forming.');
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(poolInvites)
        .where(and(eq(poolInvites.poolId, pool.id), eq(poolInvites.status, 'ACCEPTED')));
      if (n >= pool.seatCap) throw AppError.conflict('POOL_FULL', 'This group is full.');
      await this.requests.lockForUpdate(tx, inv.requestId);
      if (!(await this.requests.transitionInTx(tx, inv.requestId, ['OPEN'], 'POOLED'))) {
        throw AppError.conflict('REQUEST_NOT_OPEN', 'Your request is no longer open.');
      }
      await tx
        .update(poolInvites)
        .set({ status: 'ACCEPTED', respondedAt: this.clock.now() })
        .where(eq(poolInvites.id, inv.id));
      await this.outbox.add(tx, 'pool.member_joined', { poolId: pool.id, joined: n + 1 });
    });
    return (await this.listInvites(student)).find((i) => i.id === inviteId)!;
  }

  async decline(student: AuthUser, inviteId: string): Promise<{ id: string; status: 'DECLINED' }> {
    const rows = await this.db
      .update(poolInvites)
      .set({ status: 'DECLINED', respondedAt: this.clock.now() })
      .where(
        and(
          eq(poolInvites.id, inviteId),
          eq(poolInvites.studentUserId, student.id),
          eq(poolInvites.status, 'INVITED'),
        ),
      )
      .returning({ id: poolInvites.id });
    if (rows.length === 0)
      throw AppError.conflict('INVITE_NOT_OPEN', 'This invitation cannot be declined.');
    return { id: inviteId, status: 'DECLINED' };
  }

  /** Expires old invitations and embeds any published request the outbox job missed. */
  async sweep(): Promise<void> {
    await this.db
      .update(poolInvites)
      .set({ status: 'EXPIRED' })
      .where(and(eq(poolInvites.status, 'INVITED'), lte(poolInvites.expiresAt, this.clock.now())));
  }

  // ================= Group booking (Part 19) =================

  async getPool(poolId: string, tx: DbExecutor = this.db) {
    const [row] = await tx.select().from(requestPools).where(eq(requestPools.id, poolId));
    return row ?? null;
  }

  async lockPool(tx: DbExecutor, poolId: string) {
    const [row] = await tx
      .select()
      .from(requestPools)
      .where(eq(requestPools.id, poolId))
      .for('update');
    return row ?? null;
  }

  /** The learner's accepted membership in a pool, or null. */
  async membership(studentUserId: string, poolId: string, tx: DbExecutor = this.db) {
    const [row] = await tx
      .select()
      .from(poolInvites)
      .where(
        and(
          eq(poolInvites.poolId, poolId),
          eq(poolInvites.studentUserId, studentUserId),
          eq(poolInvites.status, 'ACCEPTED'),
        ),
      );
    return row ?? null;
  }

  async memberCount(poolId: string, tx: DbExecutor = this.db): Promise<number> {
    const [{ n } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(poolInvites)
      .where(and(eq(poolInvites.poolId, poolId), eq(poolInvites.status, 'ACCEPTED')));
    return n;
  }

  /** Guarded pool status change inside the caller's transaction. */
  async setStatusInTx(
    tx: DbExecutor,
    poolId: string,
    from: PoolStatus[],
    to: PoolStatus,
    extra: { acceptedBidId?: string; sessionId?: string; paymentDeadline?: Date } = {},
  ): Promise<boolean> {
    const rows = await tx
      .update(requestPools)
      .set({ status: to, ...extra })
      .where(and(eq(requestPools.id, poolId), inArray(requestPools.status, from)))
      .returning({ id: requestPools.id });
    if (rows.length && (to === 'EXPIRED' || to === 'CANCELLED')) {
      await tx
        .update(poolInvites)
        .set({ status: 'EXPIRED' })
        .where(
          and(eq(poolInvites.poolId, poolId), inArray(poolInvites.status, ['INVITED', 'ACCEPTED'])),
        );
    }
    return rows.length > 0;
  }

  /** Request ids of members who joined the pool. */
  async memberRequestIds(poolId: string, tx: DbExecutor = this.db): Promise<string[]> {
    const rows = await tx
      .select({ requestId: poolInvites.requestId })
      .from(poolInvites)
      .where(and(eq(poolInvites.poolId, poolId), eq(poolInvites.status, 'ACCEPTED')));
    return rows.map((r) => r.requestId);
  }

  /** Pools tutors can bid on: forming or bidding, in the given skills. */
  async openPools(skillIds: string[]) {
    if (skillIds.length === 0) return [];
    return this.db
      .select()
      .from(requestPools)
      .where(
        and(
          inArray(requestPools.status, ['FORMING', 'BIDDING']),
          inArray(requestPools.skillId, skillIds),
        ),
      )
      .orderBy(asc(requestPools.createdAt))
      .limit(100);
  }

  /** Sessions of expired pools (their paid seats must be refunded). */
  async expiredSessionIds(limit = 200): Promise<string[]> {
    const rows = await this.db
      .select({ sessionId: requestPools.sessionId })
      .from(requestPools)
      .where(and(eq(requestPools.status, 'EXPIRED'), isNotNull(requestPools.sessionId)))
      .limit(limit);
    return rows.map((r) => r.sessionId!);
  }

  /** Pools waiting for payments. */
  async awaitingPayments(limit = 100) {
    return this.db
      .select()
      .from(requestPools)
      .where(eq(requestPools.status, 'AWAITING_PAYMENTS'))
      .limit(limit);
  }

  private async activeInvite(requestId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: poolInvites.id })
      .from(poolInvites)
      .where(
        and(
          eq(poolInvites.requestId, requestId),
          inArray(poolInvites.status, ['INVITED', 'ACCEPTED']),
        ),
      )
      .limit(1);
    return Boolean(row);
  }
}

@Module({
  imports: [RequestsModule, CatalogModule],
  providers: [PoolingService, { provide: EmbeddingProvider, useClass: FakeEmbeddingProvider }],
  exports: [PoolingService, EmbeddingProvider],
})
export class PoolingModule {}
