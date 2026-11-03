import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, type SQL } from 'drizzle-orm';
import { AuditService } from '../../platform/audit/audit.service';
import { Clock } from '../../platform/clock/clock';
import { InjectDb, type Database } from '../../platform/database/database.module';
import { AppError } from '../../platform/errors/app-error';
import { auditActor, type AuthUser } from '../../platform/http/request-context';
import { CatalogService, type Page, type SkillView } from '../catalog/catalog.service';
import { UsersService } from '../identity/users.service';
import { ModerationService } from '../moderation/moderation.service';
import {
  tutorProfiles,
  tutorSkills,
  type TutorBadge,
  type TutorProfileRow,
  type TutorSkillRow,
  type TutorSkillStatus,
  type VerificationStatus,
} from './tutors.schema';

// ---------- Views ----------

export interface TutorSkillView {
  skill: SkillView;
  status: TutorSkillStatus;
  experienceYears: number | null;
  summary: string;
  evidenceLinks: string[];
  rejectionReason: string | null;
  decidedAt: string | null;
}

/** The tutor's own view, including private payout details and every skill claim. */
export interface TutorProfileView {
  userId: string;
  headline: string;
  bio: string;
  experienceYears: number | null;
  languages: string[];
  badge: TutorBadge;
  verificationStatus: VerificationStatus;
  payoutUpiId: string | null;
  verificationSubmittedAt: string | null;
  verificationDecidedAt: string | null;
  verificationRejectionReason: string | null;
  skills: TutorSkillView[];
}

/** Safe for anyone to see: approved skills only, no payout or contact details. */
export interface PublicTutorView {
  userId: string;
  fullName: string;
  headline: string;
  bio: string;
  experienceYears: number | null;
  languages: string[];
  badge: TutorBadge;
  skills: Array<{ skill: SkillView; experienceYears: number | null; summary: string }>;
}

/** Staff review queue items. */
export interface ProfileReviewItem extends TutorProfileView {
  fullName: string;
  email: string;
}

export interface SkillReviewItem extends TutorSkillView {
  tutorUserId: string;
  tutorName: string;
  tutorVerificationStatus: VerificationStatus;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Owns `tutor_profiles` and `tutor_skills`.
 */
@Injectable()
export class TutorsService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
    private readonly catalog: CatalogService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly moderation: ModerationService,
  ) {}

  // ================= Reads for other modules =================

  async findProfile(userId: string): Promise<TutorProfileRow | null> {
    const [row] = await this.db
      .select()
      .from(tutorProfiles)
      .where(eq(tutorProfiles.userId, userId));
    return row ?? null;
  }

  async isVerified(userId: string): Promise<boolean> {
    return (await this.findProfile(userId))?.verificationStatus === 'VERIFIED';
  }

  /** True when the tutor is verified and approved for this (active) skill. Used by bidding (Part 5). */
  async canTeach(userId: string, skillId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ status: tutorSkills.status, profile: tutorProfiles.verificationStatus })
      .from(tutorSkills)
      .innerJoin(tutorProfiles, eq(tutorProfiles.userId, tutorSkills.tutorUserId))
      .where(and(eq(tutorSkills.tutorUserId, userId), eq(tutorSkills.skillId, skillId)));
    if (row?.status !== 'APPROVED' || row.profile !== 'VERIFIED') return false;
    return (await this.catalog.findActiveSkills([skillId])).length === 1;
  }

  /** Active skills this tutor may currently teach (empty unless the profile is verified). */
  async teachableSkillIds(userId: string): Promise<string[]> {
    if (!(await this.isVerified(userId))) return [];
    const rows = await this.db
      .select({ skillId: tutorSkills.skillId })
      .from(tutorSkills)
      .where(and(eq(tutorSkills.tutorUserId, userId), eq(tutorSkills.status, 'APPROVED')));
    const active = await this.catalog.findActiveSkills(rows.map((r) => r.skillId));
    return active.map((s) => s.id);
  }

  /** Public card data (name, badge, headline) for showing tutors next to bids. */
  async cards(
    userIds: string[],
  ): Promise<
    Map<string, { userId: string; fullName: string; badge: TutorBadge; headline: string }>
  > {
    if (userIds.length === 0) return new Map();
    const [rows, names] = await Promise.all([
      this.db
        .select({
          userId: tutorProfiles.userId,
          badge: tutorProfiles.badge,
          headline: tutorProfiles.headline,
        })
        .from(tutorProfiles)
        .where(inArray(tutorProfiles.userId, [...new Set(userIds)])),
      this.users.getPublicUsers(userIds),
    ]);
    return new Map(
      rows.map((r) => [r.userId, { ...r, fullName: names.get(r.userId)?.fullName ?? '' }]),
    );
  }

  // ================= Tutor app =================

  async getOwnProfile(userId: string): Promise<TutorProfileView> {
    const row = await this.findProfile(userId);
    if (!row) {
      throw AppError.notFound('TUTOR_PROFILE_NOT_FOUND', 'Create your tutor profile first.');
    }
    return this.toView(row, await this.skillsOf([userId]));
  }

  async upsertProfile(
    user: AuthUser,
    input: {
      headline?: string;
      bio?: string;
      experienceYears?: number;
      languages?: string[];
      payoutUpiId?: string;
    },
  ): Promise<TutorProfileView> {
    const now = this.clock.now();
    const screened = await this.moderation.screenFields(
      user.id,
      { headline: input.headline, bio: input.bio },
      { entityType: 'TUTOR_PROFILE', entityId: user.id },
    );
    const changes = Object.fromEntries(
      Object.entries({ ...input, ...screened }).filter(([, v]) => v !== undefined),
    ) as typeof input;
    await this.db
      .insert(tutorProfiles)
      .values({ userId: user.id, ...changes, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: tutorProfiles.userId, set: { ...changes, updatedAt: now } });
    return this.getOwnProfile(user.id);
  }

  /**
   * Adds a skill claim (PENDING) or updates its details. Editing a REJECTED claim
   * sends it back to PENDING; editing an APPROVED claim keeps it approved.
   */
  async upsertSkill(
    user: AuthUser,
    skillId: string,
    input: { experienceYears?: number; summary: string; evidenceLinks: string[] },
  ): Promise<TutorProfileView> {
    await this.requireProfile(user.id);
    if ((await this.catalog.findActiveSkills([skillId])).length === 0) {
      throw AppError.badRequest('UNKNOWN_SKILL', 'This skill does not exist or is not active.');
    }
    const [{ n } = { n: 0 }] = await this.db
      .select({ n: count() })
      .from(tutorSkills)
      .where(eq(tutorSkills.tutorUserId, user.id));

    const now = this.clock.now();
    const [existing] = await this.db
      .select({ status: tutorSkills.status })
      .from(tutorSkills)
      .where(and(eq(tutorSkills.tutorUserId, user.id), eq(tutorSkills.skillId, skillId)));
    if (!existing && n >= 20) {
      throw AppError.conflict('TOO_MANY_SKILLS', 'A tutor can list at most 20 skills.');
    }

    const summary = await this.moderation.screen(user.id, input.summary, {
      entityType: 'TUTOR_SKILL',
      entityId: `${user.id}:${skillId}`,
      field: 'summary',
    });
    const details = {
      experienceYears: input.experienceYears ?? null,
      summary,
      evidenceLinks: input.evidenceLinks,
      updatedAt: now,
    };
    if (!existing) {
      await this.db
        .insert(tutorSkills)
        .values({ tutorUserId: user.id, skillId, ...details, createdAt: now });
    } else {
      const backToPending = existing.status === 'REJECTED';
      await this.db
        .update(tutorSkills)
        .set({
          ...details,
          ...(backToPending
            ? {
                status: 'PENDING' as const,
                rejectionReason: null,
                decidedAt: null,
                decidedBy: null,
              }
            : {}),
        })
        .where(and(eq(tutorSkills.tutorUserId, user.id), eq(tutorSkills.skillId, skillId)));
    }
    return this.getOwnProfile(user.id);
  }

  async removeSkill(user: AuthUser, skillId: string): Promise<TutorProfileView> {
    // TODO(Part 5): refuse while the tutor has active bids for this skill.
    const deleted = await this.db
      .delete(tutorSkills)
      .where(and(eq(tutorSkills.tutorUserId, user.id), eq(tutorSkills.skillId, skillId)))
      .returning({ skillId: tutorSkills.skillId });
    if (deleted.length === 0) {
      throw AppError.notFound('TUTOR_SKILL_NOT_FOUND', 'You have not listed this skill.');
    }
    return this.getOwnProfile(user.id);
  }

  /** NOT_SUBMITTED or REJECTED -> PENDING. */
  async submitForVerification(user: AuthUser): Promise<TutorProfileView> {
    const profile = await this.getOwnProfile(user.id);
    const missing: string[] = [];
    if (profile.bio.length < 30) missing.push('bio (at least 30 characters)');
    if (profile.skills.length === 0) missing.push('at least one skill');
    if (!profile.payoutUpiId) missing.push('payoutUpiId');
    if (missing.length > 0) {
      throw AppError.badRequest('PROFILE_INCOMPLETE', 'Complete your profile before submitting.', {
        missing,
      });
    }

    const now = this.clock.now();
    const updated = await this.db
      .update(tutorProfiles)
      .set({
        verificationStatus: 'PENDING',
        verificationSubmittedAt: now,
        verificationRejectionReason: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(tutorProfiles.userId, user.id),
          inArray(tutorProfiles.verificationStatus, ['NOT_SUBMITTED', 'REJECTED']),
        ),
      )
      .returning({ userId: tutorProfiles.userId });
    if (updated.length === 0) {
      throw AppError.conflict(
        'INVALID_VERIFICATION_STATE',
        `Verification cannot be submitted while it is ${profile.verificationStatus}.`,
        { verificationStatus: profile.verificationStatus },
      );
    }
    return this.getOwnProfile(user.id);
  }

  // ================= Public =================

  async getPublicProfile(userId: string): Promise<PublicTutorView> {
    const row = await this.findProfile(userId);
    // Same 404 for "missing" and "not verified".
    if (!row || row.verificationStatus !== 'VERIFIED') {
      throw AppError.notFound('TUTOR_NOT_FOUND', 'Tutor not found.');
    }
    const [view] = await this.toPublicViews([row]);
    if (!view) throw AppError.notFound('TUTOR_NOT_FOUND', 'Tutor not found.');
    return view;
  }

  /** Verified tutors, optionally only those approved for a skill. */
  async listPublicTutors(input: {
    skillId?: string;
    limit: number;
    offset: number;
  }): Promise<Page<PublicTutorView>> {
    const filters: SQL[] = [eq(tutorProfiles.verificationStatus, 'VERIFIED')];
    let base = this.db.select({ profile: tutorProfiles }).from(tutorProfiles).$dynamic();
    let countQuery = this.db.select({ n: count() }).from(tutorProfiles).$dynamic();
    if (input.skillId) {
      const join = and(
        eq(tutorSkills.tutorUserId, tutorProfiles.userId),
        eq(tutorSkills.skillId, input.skillId),
        eq(tutorSkills.status, 'APPROVED'),
      );
      base = base.innerJoin(tutorSkills, join);
      countQuery = countQuery.innerJoin(tutorSkills, join);
    }
    const where = and(...filters);
    const [rows, [total]] = await Promise.all([
      base
        .where(where)
        .orderBy(asc(tutorProfiles.verificationDecidedAt))
        .limit(input.limit)
        .offset(input.offset),
      countQuery.where(where),
    ]);
    const items = await this.toPublicViews(rows.map((r) => r.profile));
    // Accounts that were suspended are dropped by toPublicViews; the total is an upper bound.
    return { items, total: total?.n ?? 0, limit: input.limit, offset: input.offset };
  }

  // ================= Staff: verification =================

  async listProfileReviews(status: VerificationStatus): Promise<ProfileReviewItem[]> {
    const rows = await this.db
      .select()
      .from(tutorProfiles)
      .where(eq(tutorProfiles.verificationStatus, status))
      .orderBy(asc(tutorProfiles.verificationSubmittedAt), asc(tutorProfiles.createdAt))
      .limit(200);
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.userId);
    const [skillsByTutor, contacts] = await Promise.all([
      this.skillsOf(ids),
      this.users.getContacts(ids),
    ]);
    return rows.map((row) => ({
      ...this.toView(row, skillsByTutor),
      fullName: contacts.get(row.userId)?.fullName ?? '',
      email: contacts.get(row.userId)?.email ?? '',
    }));
  }

  /** PENDING -> VERIFIED with a badge. Audited in the same transaction. */
  async approveProfile(
    staff: AuthUser,
    tutorUserId: string,
    input: { badge: Exclude<TutorBadge, 'NONE'> },
    requestId: string | null,
  ): Promise<TutorProfileView> {
    await this.decideProfile(staff, tutorUserId, requestId, 'tutor.verification.approved', {
      verificationStatus: 'VERIFIED',
      badge: input.badge,
      verificationRejectionReason: null,
    });
    return this.getOwnProfile(tutorUserId);
  }

  /** PENDING -> REJECTED. The tutor may fix their profile and resubmit. */
  async rejectProfile(
    staff: AuthUser,
    tutorUserId: string,
    reason: string,
    requestId: string | null,
  ): Promise<TutorProfileView> {
    await this.decideProfile(staff, tutorUserId, requestId, 'tutor.verification.rejected', {
      verificationStatus: 'REJECTED',
      badge: 'NONE',
      verificationRejectionReason: reason,
    });
    return this.getOwnProfile(tutorUserId);
  }

  async listSkillReviews(status: TutorSkillStatus): Promise<SkillReviewItem[]> {
    const rows = await this.db
      .select({ claim: tutorSkills, profileStatus: tutorProfiles.verificationStatus })
      .from(tutorSkills)
      .innerJoin(tutorProfiles, eq(tutorProfiles.userId, tutorSkills.tutorUserId))
      .where(eq(tutorSkills.status, status))
      .orderBy(asc(tutorSkills.updatedAt))
      .limit(200);
    if (rows.length === 0) return [];
    const [skillMap, names] = await Promise.all([
      this.catalog.findSkills(rows.map((r) => r.claim.skillId)),
      this.users.getPublicUsers(rows.map((r) => r.claim.tutorUserId)),
    ]);
    return rows.flatMap((r) => {
      const skill = skillMap.get(r.claim.skillId);
      if (!skill) return [];
      return [
        {
          ...this.toSkillView(r.claim, skill),
          tutorUserId: r.claim.tutorUserId,
          tutorName: names.get(r.claim.tutorUserId)?.fullName ?? '',
          tutorVerificationStatus: r.profileStatus,
        },
      ];
    });
  }

  /** PENDING -> APPROVED or REJECTED for one skill claim. Audited. */
  async decideSkill(
    staff: AuthUser,
    tutorUserId: string,
    skillId: string,
    decision: { approve: true } | { approve: false; reason: string },
    requestId: string | null,
  ): Promise<TutorProfileView> {
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(tutorSkills)
        .set({
          status: decision.approve ? 'APPROVED' : 'REJECTED',
          rejectionReason: decision.approve ? null : decision.reason,
          decidedBy: staff.id,
          decidedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(tutorSkills.tutorUserId, tutorUserId),
            eq(tutorSkills.skillId, skillId),
            eq(tutorSkills.status, 'PENDING'),
          ),
        )
        .returning({ skillId: tutorSkills.skillId });
      if (updated.length === 0) {
        const [row] = await tx
          .select({ status: tutorSkills.status })
          .from(tutorSkills)
          .where(and(eq(tutorSkills.tutorUserId, tutorUserId), eq(tutorSkills.skillId, skillId)));
        if (!row) throw AppError.notFound('TUTOR_SKILL_NOT_FOUND', 'Skill claim not found.');
        throw AppError.conflict(
          'INVALID_SKILL_REVIEW_STATE',
          `Only PENDING skill claims can be decided. This one is ${row.status}.`,
          { status: row.status },
        );
      }
      await this.audit.record(
        {
          actor: auditActor(staff),
          action: decision.approve ? 'tutor.skill.approved' : 'tutor.skill.rejected',
          entityType: 'tutor_skill',
          entityId: `${tutorUserId}:${skillId}`,
          metadata: decision.approve
            ? { tutorUserId, skillId }
            : { tutorUserId, skillId, reason: decision.reason },
          requestId,
        },
        tx,
      );
    });
    return this.getOwnProfile(tutorUserId);
  }

  // ================= Helpers =================

  private async requireProfile(userId: string): Promise<TutorProfileRow> {
    const row = await this.findProfile(userId);
    if (!row)
      throw AppError.notFound('TUTOR_PROFILE_NOT_FOUND', 'Create your tutor profile first.');
    return row;
  }

  private async decideProfile(
    staff: AuthUser,
    tutorUserId: string,
    requestId: string | null,
    action: string,
    changes: {
      verificationStatus: 'VERIFIED' | 'REJECTED';
      badge: TutorBadge;
      verificationRejectionReason: string | null;
    },
  ): Promise<void> {
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(tutorProfiles)
        .set({
          ...changes,
          verificationDecidedAt: now,
          verificationDecidedBy: staff.id,
          updatedAt: now,
        })
        .where(
          and(
            eq(tutorProfiles.userId, tutorUserId),
            eq(tutorProfiles.verificationStatus, 'PENDING'),
          ),
        )
        .returning({ userId: tutorProfiles.userId });
      if (updated.length === 0) {
        const row = await this.findProfile(tutorUserId);
        if (!row) throw AppError.notFound('TUTOR_PROFILE_NOT_FOUND', 'Tutor profile not found.');
        throw AppError.conflict(
          'INVALID_VERIFICATION_STATE',
          `Only PENDING verifications can be decided. This one is ${row.verificationStatus}.`,
          { verificationStatus: row.verificationStatus },
        );
      }
      await this.audit.record(
        {
          actor: auditActor(staff),
          action,
          entityType: 'tutor_profile',
          entityId: tutorUserId,
          metadata: { badge: changes.badge, reason: changes.verificationRejectionReason },
          requestId,
        },
        tx,
      );
    });
  }

  private async skillsOf(tutorIds: string[]): Promise<Map<string, TutorSkillView[]>> {
    const rows = await this.db
      .select()
      .from(tutorSkills)
      .where(inArray(tutorSkills.tutorUserId, tutorIds));
    const skillMap = await this.catalog.findSkills(rows.map((r) => r.skillId));
    const out = new Map<string, TutorSkillView[]>();
    for (const row of rows) {
      const skill = skillMap.get(row.skillId);
      if (!skill) continue;
      const list = out.get(row.tutorUserId) ?? [];
      list.push(this.toSkillView(row, skill));
      out.set(row.tutorUserId, list);
    }
    for (const list of out.values()) list.sort((a, b) => a.skill.name.localeCompare(b.skill.name));
    return out;
  }

  private async toPublicViews(rows: TutorProfileRow[]): Promise<PublicTutorView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.userId);
    const [skillsByTutor, contacts] = await Promise.all([
      this.skillsOf(ids),
      this.users.getContacts(ids),
    ]);
    return rows.flatMap((row) => {
      const person = contacts.get(row.userId);
      if (!person || person.status !== 'ACTIVE') return []; // hide suspended or banned tutors
      return [
        {
          userId: row.userId,
          fullName: person.fullName,
          headline: row.headline,
          bio: row.bio,
          experienceYears: row.experienceYears,
          languages: row.languages,
          badge: row.badge,
          skills: (skillsByTutor.get(row.userId) ?? [])
            .filter((s) => s.status === 'APPROVED' && s.skill.isActive)
            .map((s) => ({
              skill: s.skill,
              experienceYears: s.experienceYears,
              summary: s.summary,
            })),
        },
      ];
    });
  }

  private toSkillView(row: TutorSkillRow, skill: SkillView): TutorSkillView {
    return {
      skill,
      status: row.status,
      experienceYears: row.experienceYears,
      summary: row.summary,
      evidenceLinks: row.evidenceLinks,
      rejectionReason: row.rejectionReason,
      decidedAt: iso(row.decidedAt),
    };
  }

  private toView(
    row: TutorProfileRow,
    skillsByTutor: Map<string, TutorSkillView[]>,
  ): TutorProfileView {
    return {
      userId: row.userId,
      headline: row.headline,
      bio: row.bio,
      experienceYears: row.experienceYears,
      languages: row.languages,
      badge: row.badge,
      verificationStatus: row.verificationStatus,
      payoutUpiId: row.payoutUpiId,
      verificationSubmittedAt: iso(row.verificationSubmittedAt),
      verificationDecidedAt: iso(row.verificationDecidedAt),
      verificationRejectionReason: row.verificationRejectionReason,
      skills: skillsByTutor.get(row.userId) ?? [],
    };
  }
}
