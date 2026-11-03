import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, lte, ne, type SQL } from 'drizzle-orm';
import { AppConfig } from '../../platform/config/app-config';
import { Clock } from '../../platform/clock/clock';
import { InjectDb, type Database, type DbExecutor } from '../../platform/database/database.module';
import { isUniqueViolation } from '../../platform/database/pg-errors';
import { AppError } from '../../platform/errors/app-error';
import type { AuthUser } from '../../platform/http/request-context';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { UploadsService } from '../../platform/storage/uploads.service';
import { assertOwnership } from '../identity/auth/ownership';
import { UsersService } from '../identity/users.service';
import { CatalogService, type Page, type SkillView } from '../catalog/catalog.service';
import { ModerationService } from '../moderation/moderation.service';
import {
  learningRequests,
  requestAttachments,
  type LearningRequestRow,
  type RequestStatus,
  type SkillLevel,
} from './requests.schema';

const MAX_ATTACHMENTS = 5;

export interface AttachmentView {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** Short-lived read URL. */
  url: string;
}

export interface RequestView {
  id: string;
  skill: Pick<SkillView, 'id' | 'slug' | 'name' | 'learnerNotice'>;
  topicId: string | null;
  level: SkillLevel;
  title: string;
  description: string;
  preferredLanguage: string | null;
  budgetHintPaise: number | null;
  currency: 'INR';
  status: RequestStatus;
  publishedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  attachments: AttachmentView[];
}

/** What tutors see: the learner is shown by first name and initial only. */
export interface TutorRequestView extends RequestView {
  studentDisplayName: string;
}

export interface RequestInput {
  skillId: string;
  topicId?: string;
  level: SkillLevel;
  title: string;
  description: string;
  preferredLanguage?: string;
  budgetHintPaise?: number;
}

export function displayName(fullName: string): string {
  const [first = 'Learner', last] = fullName.trim().split(/\s+/);
  return last ? `${first} ${last[0]!.toUpperCase()}.` : first;
}

/**
 * Owns `learning_requests` and `request_attachments`.
 * Status changes are guarded updates; no row changed = 409.
 */
@Injectable()
export class RequestsService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly catalog: CatalogService,
    private readonly moderation: ModerationService,
    private readonly uploads: UploadsService,
    private readonly outbox: OutboxService,
    private readonly users: UsersService,
  ) {}

  // ================= Student =================

  async create(user: AuthUser, input: RequestInput): Promise<RequestView> {
    await this.validateSkill(input.skillId, input.topicId);
    const clean = await this.moderation.screenFields(
      user.id,
      { title: input.title, description: input.description },
      { entityType: 'LEARNING_REQUEST' },
    );
    const now = this.clock.now();
    const [row] = await this.db
      .insert(learningRequests)
      .values({
        studentUserId: user.id,
        skillId: input.skillId,
        topicId: input.topicId ?? null,
        level: input.level,
        title: clean.title,
        description: clean.description,
        preferredLanguage: input.preferredLanguage ?? null,
        budgetHintPaise: input.budgetHintPaise ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return this.toView(row!);
  }

  async update(user: AuthUser, id: string, input: Partial<RequestInput>): Promise<RequestView> {
    const current = await this.requireOwned(user, id);
    if (input.skillId || input.topicId) {
      await this.validateSkill(
        input.skillId ?? current.skillId,
        input.topicId ?? current.topicId ?? undefined,
      );
    }
    const clean = await this.moderation.screenFields(
      user.id,
      { title: input.title, description: input.description },
      { entityType: 'LEARNING_REQUEST', entityId: id },
    );
    const changes = Object.fromEntries(
      Object.entries({ ...input, ...clean }).filter(([, v]) => v !== undefined),
    );
    const [row] = await this.db
      .update(learningRequests)
      .set({ ...changes, updatedAt: this.clock.now() })
      .where(and(eq(learningRequests.id, id), eq(learningRequests.status, 'DRAFT')))
      .returning();
    if (!row) throw this.invalidState(current.status, 'edited (only drafts can be edited)');
    return this.toView(row);
  }

  /** DRAFT -> OPEN. Starts the bidding window. */
  async publish(user: AuthUser, id: string): Promise<RequestView> {
    const current = await this.requireOwned(user, id);
    await this.moderation.assertCanPost(user.id);
    if ((await this.catalog.findActiveSkills([current.skillId])).length === 0) {
      throw AppError.conflict('SKILL_INACTIVE', 'This skill is no longer offered.');
    }
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.config.env.REQUEST_TTL_HOURS * 3_600_000);
    const row = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(learningRequests)
        .set({ status: 'OPEN', publishedAt: now, expiresAt, updatedAt: now })
        .where(and(eq(learningRequests.id, id), eq(learningRequests.status, 'DRAFT')))
        .returning();
      if (!updated) throw this.invalidState(current.status, 'published');
      await this.outbox.add(tx, 'request.published', {
        requestId: id,
        skillId: updated.skillId,
        level: updated.level,
      });
      return updated;
    });
    return this.toView(row);
  }

  /**
   * DRAFT|OPEN -> CANCELLED, in the caller's transaction (bidding expires the bids in the same
   * transaction). Returns the previous status.
   */
  async cancelInTx(tx: DbExecutor, user: AuthUser, id: string): Promise<RequestStatus> {
    const current = await this.requireOwned(user, id, tx);
    const now = this.clock.now();
    const [row] = await tx
      .update(learningRequests)
      .set({ status: 'CANCELLED', closedAt: now, updatedAt: now })
      .where(and(eq(learningRequests.id, id), inArray(learningRequests.status, ['DRAFT', 'OPEN'])))
      .returning({ id: learningRequests.id });
    if (!row) throw this.invalidState(current.status, 'cancelled');
    if (current.status === 'OPEN') {
      await this.outbox.add(tx, 'request.closed', {
        requestId: id,
        studentUserId: current.studentUserId,
        status: 'CANCELLED',
      });
    }
    return current.status;
  }

  /** OPEN past expiry -> EXPIRED, in the caller's transaction. Idempotent. Returns expired ids. */
  async expireDueInTx(tx: DbExecutor, limit = 500): Promise<LearningRequestRow[]> {
    const now = this.clock.now();
    const due = await tx
      .select({ id: learningRequests.id })
      .from(learningRequests)
      .where(and(eq(learningRequests.status, 'OPEN'), lte(learningRequests.expiresAt, now)))
      .limit(limit)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];
    const rows = await tx
      .update(learningRequests)
      .set({ status: 'EXPIRED', closedAt: now, updatedAt: now })
      .where(
        and(
          inArray(
            learningRequests.id,
            due.map((d) => d.id),
          ),
          eq(learningRequests.status, 'OPEN'),
        ),
      )
      .returning();
    for (const r of rows) {
      await this.outbox.add(tx, 'request.closed', {
        requestId: r.id,
        studentUserId: r.studentUserId,
        status: 'EXPIRED',
      });
    }
    return rows;
  }

  async listOwn(
    user: AuthUser,
    q: { status?: RequestStatus; limit: number; offset: number },
  ): Promise<Page<RequestView>> {
    const filters: SQL[] = [eq(learningRequests.studentUserId, user.id)];
    if (q.status) filters.push(eq(learningRequests.status, q.status));
    const where = and(...filters);
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(learningRequests)
        .where(where)
        .orderBy(desc(learningRequests.createdAt))
        .limit(q.limit)
        .offset(q.offset),
      this.db.select({ n: count() }).from(learningRequests).where(where),
    ]);
    return {
      items: await this.toViews(rows),
      total: total?.n ?? 0,
      limit: q.limit,
      offset: q.offset,
    };
  }

  async getOwn(user: AuthUser, id: string): Promise<RequestView> {
    return this.toView(await this.requireOwned(user, id));
  }

  async addAttachment(
    user: AuthUser,
    id: string,
    input: { objectKey: string; fileName: string },
  ): Promise<RequestView> {
    const current = await this.requireOwned(user, id);
    if (current.status !== 'DRAFT' && current.status !== 'OPEN') {
      throw this.invalidState(current.status, 'changed');
    }
    const [{ n } = { n: 0 }] = await this.db
      .select({ n: count() })
      .from(requestAttachments)
      .where(eq(requestAttachments.requestId, id));
    if (n >= MAX_ATTACHMENTS) {
      throw AppError.conflict(
        'TOO_MANY_ATTACHMENTS',
        `A request can have at most ${MAX_ATTACHMENTS} files.`,
      );
    }
    const file = await this.uploads.verify(user.id, 'REQUEST_ATTACHMENT', input.objectKey);
    try {
      await this.db.insert(requestAttachments).values({
        requestId: id,
        objectKey: file.objectKey,
        fileName: input.fileName,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        createdAt: this.clock.now(),
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw AppError.conflict('ATTACHMENT_EXISTS', 'This file is already attached.');
      }
      throw err;
    }
    return this.toView(current);
  }

  // ================= Booking (Parts 7 and 9) =================

  /**
   * Guarded status change inside the caller's transaction. Returns false when the request
   * was not in one of the `from` states (the caller turns that into a 409 or a no-op).
   */
  async transitionInTx(
    tx: DbExecutor,
    id: string,
    from: RequestStatus[],
    to: RequestStatus,
  ): Promise<boolean> {
    const now = this.clock.now();
    const rows = await tx
      .update(learningRequests)
      .set({
        status: to,
        updatedAt: now,
        ...(to === 'OPEN' ? { closedAt: null } : {}),
        ...(to === 'BOOKED' || to === 'CANCELLED' || to === 'EXPIRED' ? { closedAt: now } : {}),
      })
      .where(and(eq(learningRequests.id, id), inArray(learningRequests.status, from)))
      .returning({ id: learningRequests.id });
    return rows.length > 0;
  }

  // ================= Tutors and other modules =================

  /** Raw request for other modules (bidding, realtime). */
  async find(id: string, tx: DbExecutor = this.db): Promise<LearningRequestRow | null> {
    const [row] = await tx.select().from(learningRequests).where(eq(learningRequests.id, id));
    return row ?? null;
  }

  /** Locks the request row for the rest of the caller's transaction. */
  async lockForUpdate(tx: DbExecutor, id: string): Promise<LearningRequestRow | null> {
    const [row] = await tx
      .select()
      .from(learningRequests)
      .where(eq(learningRequests.id, id))
      .for('update');
    return row ?? null;
  }

  /** OPEN requests in the given skills, newest first, excluding the tutor's own requests. */
  async browseOpen(q: {
    skillIds: string[];
    excludeStudentId: string;
    level?: SkillLevel;
    limit: number;
    offset: number;
  }): Promise<Page<TutorRequestView>> {
    if (q.skillIds.length === 0) return { items: [], total: 0, limit: q.limit, offset: q.offset };
    const filters: SQL[] = [
      eq(learningRequests.status, 'OPEN'),
      inArray(learningRequests.skillId, q.skillIds),
      ne(learningRequests.studentUserId, q.excludeStudentId),
    ];
    if (q.level) filters.push(eq(learningRequests.level, q.level));
    const where = and(...filters);
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(learningRequests)
        .where(where)
        .orderBy(desc(learningRequests.publishedAt), asc(learningRequests.id))
        .limit(q.limit)
        .offset(q.offset),
      this.db.select({ n: count() }).from(learningRequests).where(where),
    ]);
    return {
      items: await this.toTutorViews(rows),
      total: total?.n ?? 0,
      limit: q.limit,
      offset: q.offset,
    };
  }

  async toTutorView(row: LearningRequestRow): Promise<TutorRequestView> {
    const [view] = await this.toTutorViews([row]);
    return view!;
  }

  // ================= Helpers =================

  private async toTutorViews(rows: LearningRequestRow[]): Promise<TutorRequestView[]> {
    const [views, names] = await Promise.all([
      this.toViews(rows),
      this.users.getPublicUsers(rows.map((r) => r.studentUserId)),
    ]);
    return views.map((v, i) => ({
      ...v,
      studentDisplayName: displayName(names.get(rows[i]!.studentUserId)?.fullName ?? ''),
    }));
  }

  private async requireOwned(
    user: AuthUser,
    id: string,
    tx: DbExecutor = this.db,
  ): Promise<LearningRequestRow> {
    const row = await this.find(id, tx);
    if (!row) throw AppError.notFound('REQUEST_NOT_FOUND', 'Request not found.');
    assertOwnership(user, row.studentUserId);
    return row;
  }

  private async validateSkill(skillId: string, topicId?: string): Promise<void> {
    const [skill] = await this.catalog.findActiveSkills([skillId]);
    if (!skill)
      throw AppError.badRequest('UNKNOWN_SKILL', 'This skill does not exist or is not active.');
    if (topicId) {
      const detail = await this.catalog.getSkill(skill.id);
      if (!detail.topics.some((t) => t.id === topicId)) {
        throw AppError.badRequest('UNKNOWN_TOPIC', 'This topic does not belong to the skill.');
      }
    }
  }

  private invalidState(status: RequestStatus, verb: string): AppError {
    return AppError.conflict('INVALID_REQUEST_STATE', `A ${status} request cannot be ${verb}.`, {
      status,
    });
  }

  private async toView(row: LearningRequestRow): Promise<RequestView> {
    return (await this.toViews([row]))[0]!;
  }

  private async toViews(rows: LearningRequestRow[]): Promise<RequestView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [skillMap, files] = await Promise.all([
      this.catalog.findSkills(rows.map((r) => r.skillId)),
      this.db
        .select()
        .from(requestAttachments)
        .where(inArray(requestAttachments.requestId, ids))
        .orderBy(asc(requestAttachments.createdAt)),
    ]);
    const urls = await Promise.all(files.map((f) => this.uploads.readUrl(f.objectKey, f.fileName)));
    return rows.map((r) => {
      const skill = skillMap.get(r.skillId);
      return {
        id: r.id,
        skill: {
          id: r.skillId,
          slug: skill?.slug ?? '',
          name: skill?.name ?? '',
          learnerNotice: skill?.learnerNotice ?? null,
        },
        topicId: r.topicId,
        level: r.level,
        title: r.title,
        description: r.description,
        preferredLanguage: r.preferredLanguage,
        budgetHintPaise: r.budgetHintPaise,
        currency: 'INR',
        status: r.status,
        publishedAt: r.publishedAt?.toISOString() ?? null,
        expiresAt: r.expiresAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        attachments: files
          .map((f, i) => ({ f, url: urls[i]! }))
          .filter(({ f }) => f.requestId === r.id)
          .map(({ f, url }) => ({
            id: f.id,
            fileName: f.fileName,
            contentType: f.contentType,
            sizeBytes: f.sizeBytes,
            url,
          })),
      };
    });
  }
}
