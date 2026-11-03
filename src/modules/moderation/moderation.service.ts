import { Injectable, Logger } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { AuditService } from '../../platform/audit/audit.service';
import { Clock } from '../../platform/clock/clock';
import { InjectDb, type Database, type DbExecutor } from '../../platform/database/database.module';
import { AppError } from '../../platform/errors/app-error';
import { auditActor, type AuthUser } from '../../platform/http/request-context';
import { OutboxService } from '../../platform/outbox/outbox.service';
import {
  ScreeningProvider,
  type ScreeningHit,
  type ScreeningSeverity,
} from '../../providers/screening/screening.provider';
import { TokenService } from '../identity/auth/token.service';
import { UsersService } from '../identity/users.service';
import {
  contentFlags,
  moderationActions,
  moderationCases,
  reports,
  userSanctions,
  type CaseStatus,
  type ModeratedEntity,
  type ModerationActionType,
  type ModerationCaseRow,
  type ReportReason,
  type SanctionType,
  type UserSanctionRow,
} from './moderation.schema';

const SEVERITY_WEIGHT: Record<ScreeningSeverity, number> = { LOW: 1, MEDIUM: 3, HIGH: 10 };
const REPORT_WEIGHT: Record<ReportReason, number> = {
  HARASSMENT: 8,
  OFF_PLATFORM_PAYMENT: 5,
  NO_SHOW: 3,
  MISLEADING_CLAIMS: 4,
  INAPPROPRIATE_CONTENT: 6,
  FINANCIAL_TIPS: 5,
  SPAM: 2,
  OTHER: 2,
};

export interface ScreenTarget {
  entityType: ModeratedEntity;
  entityId?: string | null;
  field: string;
}

export interface SanctionView {
  id: string;
  type: SanctionType;
  reason: string;
  startsAt: string;
  endsAt: string | null;
  liftedAt: string | null;
  caseId: string | null;
}

export interface CaseSummary {
  id: string;
  subjectUserId: string;
  subjectName: string;
  status: CaseStatus;
  priority: number;
  assignedTo: string | null;
  openedAt: string;
  lastActivityAt: string;
  reportCount: number;
  flagCount: number;
}

const toSanction = (s: UserSanctionRow): SanctionView => ({
  id: s.id,
  type: s.type,
  reason: s.reason,
  startsAt: s.startsAt.toISOString(),
  endsAt: s.endsAt?.toISOString() ?? null,
  liftedAt: s.liftedAt?.toISOString() ?? null,
  caseId: s.caseId,
});

/**
 * Trust & safety. Owns flags, reports, cases, actions and sanctions.
 * Other modules call `screen()` on user-written text and `assertCanPost/Bid()` before acting.
 */
@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
    private readonly screening: ScreeningProvider,
    private readonly users: UsersService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // ================= Screening =================

  /**
   * Screens user-written text. Returns the text with contact details masked.
   * Throws 422 CONTENT_BLOCKED for abusive text. Every hit is recorded; MEDIUM and HIGH
   * hits open (or join) a moderation case. Recording happens outside the caller's
   * transaction so a blocked request still leaves its evidence.
   */
  async screen(userId: string, text: string, target: ScreenTarget): Promise<string> {
    if (!text) return text;
    const result = this.screening.screen(text);
    if (result.hits.length > 0) {
      await this.recordFlags(userId, target, result.hits);
    }
    if (result.blocked) {
      throw new AppError(422, 'CONTENT_BLOCKED', 'This text breaks our community guidelines.', {
        field: target.field,
        rules: [...new Set(result.hits.filter((h) => h.action === 'BLOCK').map((h) => h.rule))],
      });
    }
    return result.text;
  }

  /** Screens several fields of one entity at once; returns the cleaned values. */
  async screenFields<T extends Record<string, string | undefined>>(
    userId: string,
    fields: T,
    target: Omit<ScreenTarget, 'field'>,
  ): Promise<T> {
    const out: Record<string, string | undefined> = { ...fields };
    for (const [field, value] of Object.entries(fields)) {
      if (typeof value === 'string')
        out[field] = await this.screen(userId, value, { ...target, field });
    }
    return out as T;
  }

  private async recordFlags(
    userId: string,
    target: ScreenTarget,
    hits: ScreeningHit[],
  ): Promise<void> {
    const serious = hits.filter((h) => h.severity !== 'LOW');
    await this.db.transaction(async (tx) => {
      const caseId = serious.length
        ? await this.attachToCase(
            tx,
            userId,
            serious.reduce((sum, h) => sum + SEVERITY_WEIGHT[h.severity], 0),
          )
        : null;
      await tx.insert(contentFlags).values(
        hits.map((h) => ({
          userId,
          entityType: target.entityType,
          entityId: target.entityId ?? null,
          field: target.field,
          rule: h.rule,
          severity: h.severity,
          action: h.action,
          excerpt: h.excerpt,
          caseId,
          createdAt: this.clock.now(),
        })),
      );
    });
  }

  // ================= Reports =================

  async report(
    reporter: AuthUser,
    input: {
      subjectUserId: string;
      reason: ReportReason;
      entityType?: ModeratedEntity;
      entityId?: string;
      details?: string;
    },
  ): Promise<{ id: string; caseId: string; createdAt: string }> {
    if (input.subjectUserId === reporter.id) {
      throw AppError.badRequest('CANNOT_REPORT_SELF', 'You cannot report yourself.');
    }
    const subject = await this.users.findById(input.subjectUserId);
    if (!subject || subject.accountType !== 'MEMBER') {
      throw AppError.notFound('USER_NOT_FOUND', 'User not found.');
    }
    return this.db.transaction(async (tx) => {
      const caseId = await this.attachToCase(tx, subject.id, REPORT_WEIGHT[input.reason]);
      const now = this.clock.now();
      const [row] = await tx
        .insert(reports)
        .values({
          reporterUserId: reporter.id,
          subjectUserId: subject.id,
          reason: input.reason,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          details: input.details ?? '',
          reportedFromApp: reporter.app,
          caseId,
          createdAt: now,
        })
        .returning({ id: reports.id });
      await this.outbox.add(tx, 'moderation.case_updated', { caseId, subjectUserId: subject.id });
      return { id: row!.id, caseId, createdAt: now.toISOString() };
    });
  }

  /** Returns the open case id for a user, creating one if needed, and raises its priority. */
  private async attachToCase(tx: DbExecutor, userId: string, weight: number): Promise<string> {
    const now = this.clock.now();
    const bump = await tx
      .update(moderationCases)
      .set({ priority: sql`${moderationCases.priority} + ${weight}`, lastActivityAt: now })
      .where(and(eq(moderationCases.subjectUserId, userId), eq(moderationCases.status, 'OPEN')))
      .returning({ id: moderationCases.id });
    if (bump[0]) return bump[0].id;
    // The partial unique index allows one OPEN case per user; a concurrent insert wins the race.
    const [created] = await tx
      .insert(moderationCases)
      .values({ subjectUserId: userId, priority: weight, openedAt: now, lastActivityAt: now })
      .onConflictDoNothing()
      .returning({ id: moderationCases.id });
    if (created) return created.id;
    const [existing] = await tx
      .update(moderationCases)
      .set({ priority: sql`${moderationCases.priority} + ${weight}`, lastActivityAt: now })
      .where(and(eq(moderationCases.subjectUserId, userId), eq(moderationCases.status, 'OPEN')))
      .returning({ id: moderationCases.id });
    if (!existing) throw AppError.conflict('CASE_RACE', 'Please retry.');
    return existing.id;
  }

  // ================= Enforcement checks for other modules =================

  async activeSanctions(userId: string, tx: DbExecutor = this.db): Promise<UserSanctionRow[]> {
    const now = this.clock.now();
    return tx
      .select()
      .from(userSanctions)
      .where(
        and(
          eq(userSanctions.userId, userId),
          isNull(userSanctions.liftedAt),
          lte(userSanctions.startsAt, now),
          or(isNull(userSanctions.endsAt), gt(userSanctions.endsAt, now)),
        ),
      );
  }

  /** Throws 403 RESTRICTED_FROM_POSTING if the member may not post learning requests. */
  async assertCanPost(userId: string): Promise<void> {
    const active = await this.activeSanctions(userId);
    const hit = active.find((s) => s.type === 'RESTRICT_POSTING');
    if (hit) {
      throw AppError.forbidden(
        'RESTRICTED_FROM_POSTING',
        'Your account is restricted from posting.',
        {
          until: hit.endsAt?.toISOString() ?? null,
        },
      );
    }
  }

  /** Throws 403 RESTRICTED_FROM_BIDDING if the tutor may not bid. */
  async assertCanBid(userId: string): Promise<void> {
    const active = await this.activeSanctions(userId);
    const hit = active.find((s) => s.type === 'RESTRICT_BIDDING');
    if (hit) {
      throw AppError.forbidden(
        'RESTRICTED_FROM_BIDDING',
        'Your account is restricted from bidding.',
        {
          until: hit.endsAt?.toISOString() ?? null,
        },
      );
    }
  }

  // ================= Admin portal =================

  async listCases(status: CaseStatus): Promise<CaseSummary[]> {
    const rows = await this.db
      .select()
      .from(moderationCases)
      .where(eq(moderationCases.status, status))
      .orderBy(desc(moderationCases.priority), asc(moderationCases.openedAt))
      .limit(200);
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [reportCounts, flagCounts, names] = await Promise.all([
      this.db
        .select({ caseId: reports.caseId, n: count() })
        .from(reports)
        .where(inArray(reports.caseId, ids))
        .groupBy(reports.caseId),
      this.db
        .select({ caseId: contentFlags.caseId, n: count() })
        .from(contentFlags)
        .where(inArray(contentFlags.caseId, ids))
        .groupBy(contentFlags.caseId),
      this.users.getPublicUsers(rows.map((r) => r.subjectUserId)),
    ]);
    const rc = new Map(reportCounts.map((r) => [r.caseId, r.n]));
    const fc = new Map(flagCounts.map((r) => [r.caseId, r.n]));
    return rows.map((r) => ({
      id: r.id,
      subjectUserId: r.subjectUserId,
      subjectName: names.get(r.subjectUserId)?.fullName ?? '',
      status: r.status,
      priority: r.priority,
      assignedTo: r.assignedTo,
      openedAt: r.openedAt.toISOString(),
      lastActivityAt: r.lastActivityAt.toISOString(),
      reportCount: rc.get(r.id) ?? 0,
      flagCount: fc.get(r.id) ?? 0,
    }));
  }

  /** Everything staff need to decide: the case, its evidence, and the member's history. */
  async getCase(id: string) {
    const c = await this.requireCase(id);
    const [caseReports, caseFlags, actions, sanctions, contacts, priorCases] = await Promise.all([
      this.db.select().from(reports).where(eq(reports.caseId, id)).orderBy(asc(reports.createdAt)),
      this.db
        .select()
        .from(contentFlags)
        .where(eq(contentFlags.caseId, id))
        .orderBy(asc(contentFlags.createdAt)),
      this.db
        .select()
        .from(moderationActions)
        .where(eq(moderationActions.caseId, id))
        .orderBy(asc(moderationActions.createdAt)),
      this.db
        .select()
        .from(userSanctions)
        .where(eq(userSanctions.userId, c.subjectUserId))
        .orderBy(desc(userSanctions.createdAt)),
      this.users.getContacts([c.subjectUserId]),
      this.db
        .select({ status: moderationCases.status, n: count() })
        .from(moderationCases)
        .where(eq(moderationCases.subjectUserId, c.subjectUserId))
        .groupBy(moderationCases.status),
    ]);
    const subject = contacts.get(c.subjectUserId);
    return {
      case: {
        id: c.id,
        status: c.status,
        priority: c.priority,
        assignedTo: c.assignedTo,
        resolution: c.resolution,
        openedAt: c.openedAt.toISOString(),
        closedAt: c.closedAt?.toISOString() ?? null,
      },
      subject: subject
        ? {
            id: subject.id,
            fullName: subject.fullName,
            email: subject.email,
            status: subject.status,
          }
        : null,
      /** Upheld cases (ACTIONED) count as strikes. */
      history: {
        strikes: priorCases.find((p) => p.status === 'ACTIONED')?.n ?? 0,
        dismissed: priorCases.find((p) => p.status === 'DISMISSED')?.n ?? 0,
      },
      reports: caseReports.map((r) => ({
        id: r.id,
        reporterUserId: r.reporterUserId,
        reason: r.reason,
        entityType: r.entityType,
        entityId: r.entityId,
        details: r.details,
        reportedFromApp: r.reportedFromApp,
        createdAt: r.createdAt.toISOString(),
      })),
      flags: caseFlags.map((f) => ({
        id: f.id,
        entityType: f.entityType,
        entityId: f.entityId,
        field: f.field,
        rule: f.rule,
        severity: f.severity,
        action: f.action,
        excerpt: f.excerpt,
        createdAt: f.createdAt.toISOString(),
      })),
      actions: actions.map((a) => ({
        id: a.id,
        actorUserId: a.actorUserId,
        action: a.action,
        reason: a.reason,
        durationDays: a.durationDays,
        createdAt: a.createdAt.toISOString(),
      })),
      sanctions: sanctions.map(toSanction),
    };
  }

  /** Staff open a case manually (e.g. from a support email). */
  async openCase(staff: AuthUser, subjectUserId: string, note: string, requestId: string | null) {
    const subject = await this.users.findById(subjectUserId);
    if (!subject || subject.accountType !== 'MEMBER') {
      throw AppError.notFound('USER_NOT_FOUND', 'User not found.');
    }
    const caseId = await this.db.transaction(async (tx) => {
      const id = await this.attachToCase(tx, subjectUserId, 1);
      await this.audit.record(
        {
          actor: auditActor(staff),
          action: 'moderation.case.opened',
          entityType: 'moderation_case',
          entityId: id,
          metadata: { subjectUserId, note },
          requestId,
        },
        tx,
      );
      return id;
    });
    return this.getCase(caseId);
  }

  async assign(staff: AuthUser, caseId: string) {
    const updated = await this.db
      .update(moderationCases)
      .set({ assignedTo: staff.id, lastActivityAt: this.clock.now() })
      .where(and(eq(moderationCases.id, caseId), eq(moderationCases.status, 'OPEN')))
      .returning({ id: moderationCases.id });
    if (updated.length === 0) throw await this.notOpen(caseId);
    return this.getCase(caseId);
  }

  /**
   * Decides an OPEN case. DISMISS closes it with no sanction; anything else closes it as
   * ACTIONED (a strike) and applies a sanction. SUSPEND and BAN sign the member out everywhere.
   */
  async act(
    staff: AuthUser,
    caseId: string,
    input: { action: ModerationActionType; reason: string; durationDays?: number },
    requestId: string | null,
  ) {
    const timed = input.action === 'SUSPEND' || input.action.startsWith('RESTRICT_');
    if (timed && !input.durationDays) {
      throw AppError.badRequest('DURATION_REQUIRED', `${input.action} needs durationDays.`);
    }
    const now = this.clock.now();
    const endsAt =
      timed && input.durationDays
        ? new Date(now.getTime() + input.durationDays * 86_400_000)
        : null;

    await this.db.transaction(async (tx) => {
      const [closed] = await tx
        .update(moderationCases)
        .set({
          status: input.action === 'DISMISS' ? 'DISMISSED' : 'ACTIONED',
          resolution: input.reason,
          closedAt: now,
          lastActivityAt: now,
          assignedTo: sql`coalesce(${moderationCases.assignedTo}, ${staff.id}::uuid)`,
        })
        .where(and(eq(moderationCases.id, caseId), eq(moderationCases.status, 'OPEN')))
        .returning();
      if (!closed) throw await this.notOpen(caseId);

      await tx.insert(moderationActions).values({
        caseId,
        actorUserId: staff.id,
        action: input.action,
        reason: input.reason,
        durationDays: timed ? (input.durationDays ?? null) : null,
        createdAt: now,
      });

      if (input.action !== 'DISMISS') {
        await tx.insert(userSanctions).values({
          userId: closed.subjectUserId,
          type: input.action,
          caseId,
          reason: input.reason,
          startsAt: now,
          endsAt,
          createdBy: staff.id,
          createdAt: now,
        });
        if (input.action === 'SUSPEND' || input.action === 'BAN') {
          await this.users.setStatus(
            closed.subjectUserId,
            input.action === 'BAN' ? 'BANNED' : 'SUSPENDED',
            tx,
          );
          await this.tokens.revokeAllForUser(
            closed.subjectUserId,
            `MODERATION_${input.action}`,
            tx,
          );
        }
        await this.outbox.add(tx, 'moderation.action_taken', {
          userId: closed.subjectUserId,
          action: input.action,
          reason: input.reason,
          endsAt: endsAt?.toISOString() ?? null,
        });
      }

      await this.audit.record(
        {
          actor: auditActor(staff),
          action: `moderation.case.${input.action.toLowerCase()}`,
          entityType: 'moderation_case',
          entityId: caseId,
          metadata: {
            subjectUserId: closed.subjectUserId,
            reason: input.reason,
            durationDays: input.durationDays ?? null,
          },
          requestId,
        },
        tx,
      );
    });
    return this.getCase(caseId);
  }

  /** Lifts an active sanction early. Reinstates the account if nothing else keeps it blocked. */
  async liftSanction(
    staff: AuthUser,
    sanctionId: string,
    reason: string,
    requestId: string | null,
  ) {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(userSanctions)
        .set({ liftedAt: this.clock.now(), liftedBy: staff.id, liftReason: reason })
        .where(and(eq(userSanctions.id, sanctionId), isNull(userSanctions.liftedAt)))
        .returning();
      if (!row) {
        throw AppError.conflict('SANCTION_NOT_ACTIVE', 'This sanction is not active.');
      }
      await this.reinstateIfClear(tx, row.userId);
      await this.audit.record(
        {
          actor: auditActor(staff),
          action: 'moderation.sanction.lifted',
          entityType: 'user_sanction',
          entityId: sanctionId,
          metadata: { userId: row.userId, type: row.type, reason },
          requestId,
        },
        tx,
      );
    });
  }

  async sanctionsFor(userId: string): Promise<SanctionView[]> {
    const rows = await this.db
      .select()
      .from(userSanctions)
      .where(eq(userSanctions.userId, userId))
      .orderBy(desc(userSanctions.createdAt));
    return rows.map(toSanction);
  }

  // ================= Worker sweep =================

  /** Lifts time-limited sanctions that have ended and reinstates suspended accounts. Idempotent. */
  async sweepExpiredSanctions(): Promise<number> {
    const now = this.clock.now();
    const expired = await this.db
      .update(userSanctions)
      .set({ liftedAt: now, liftReason: 'EXPIRED' })
      .where(and(isNull(userSanctions.liftedAt), lte(userSanctions.endsAt, now)))
      .returning({ userId: userSanctions.userId, type: userSanctions.type });
    for (const userId of new Set(
      expired.filter((e) => e.type === 'SUSPEND').map((e) => e.userId),
    )) {
      await this.db.transaction((tx) => this.reinstateIfClear(tx, userId));
    }
    if (expired.length) this.logger.log(`Lifted ${expired.length} expired sanctions`);
    return expired.length;
  }

  private async reinstateIfClear(tx: DbExecutor, userId: string): Promise<void> {
    const user = await this.users.findById(userId, tx);
    if (!user || user.status === 'ACTIVE') return;
    const blocking = (await this.activeSanctions(userId, tx)).some(
      (s) => s.type === 'SUSPEND' || s.type === 'BAN',
    );
    if (!blocking) await this.users.setStatus(userId, 'ACTIVE', tx);
  }

  // ================= Helpers =================

  private async requireCase(id: string): Promise<ModerationCaseRow> {
    const [row] = await this.db.select().from(moderationCases).where(eq(moderationCases.id, id));
    if (!row) throw AppError.notFound('CASE_NOT_FOUND', 'Case not found.');
    return row;
  }

  private async notOpen(id: string): Promise<AppError> {
    const row = await this.requireCase(id);
    return AppError.conflict('CASE_NOT_OPEN', `This case is already ${row.status}.`, {
      status: row.status,
    });
  }
}
