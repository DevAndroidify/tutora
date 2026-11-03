import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { skills } from '../catalog/catalog.schema';
import { users } from '../identity/identity.schema';

/** NONE until the profile is approved. EXPERT is for proven, top-rated tutors. */
export const TUTOR_BADGES = ['NONE', 'VERIFIED', 'EXPERT'] as const;
export type TutorBadge = (typeof TUTOR_BADGES)[number];
export const APPROVABLE_BADGES = ['VERIFIED', 'EXPERT'] as const;

export const VERIFICATION_STATUSES = ['NOT_SUBMITTED', 'PENDING', 'VERIFIED', 'REJECTED'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const TUTOR_SKILL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type TutorSkillStatus = (typeof TUTOR_SKILL_STATUSES)[number];

export const tutorBadge = pgEnum('tutor_badge', TUTOR_BADGES);
export const tutorVerificationStatus = pgEnum('tutor_verification_status', VERIFICATION_STATUSES);
export const tutorSkillStatus = pgEnum('tutor_skill_status', TUTOR_SKILL_STATUSES);

/**
 * A member's teaching profile. Created when a member starts using the tutor app.
 * Verification here is about the person (identity, professionalism);
 * each skill they teach is approved separately in `tutor_skills`.
 */
export const tutorProfiles = pgTable(
  'tutor_profiles',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    headline: text('headline').notNull().default(''),
    bio: text('bio').notNull().default(''),
    experienceYears: integer('experience_years'),
    /** Teaching languages, e.g. {English, Hindi}. */
    languages: text('languages')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    badge: tutorBadge('badge').notNull().default('NONE'),
    verificationStatus: tutorVerificationStatus('verification_status')
      .notNull()
      .default('NOT_SUBMITTED'),
    /** Private. Never returned on public endpoints. */
    payoutUpiId: text('payout_upi_id'),
    /** Set by admins once Razorpay Route onboarding is done (Part 12). */
    razorpayLinkedAccountId: text('razorpay_linked_account_id'),
    verificationSubmittedAt: timestamp('verification_submitted_at', { withTimezone: true }),
    verificationDecidedAt: timestamp('verification_decided_at', { withTimezone: true }),
    verificationDecidedBy: uuid('verification_decided_by'),
    verificationRejectionReason: text('verification_rejection_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tutor_profiles_verification_status_idx').on(t.verificationStatus),
    check(
      'tutor_profiles_badge_needs_verification',
      sql`${t.badge} = 'NONE' or ${t.verificationStatus} = 'VERIFIED'`,
    ),
    check(
      'tutor_profiles_experience_years_range',
      sql`${t.experienceYears} is null or ${t.experienceYears} between 0 and 60`,
    ),
  ],
);

/**
 * A tutor's claim to teach one skill, with evidence (portfolio, certificates, channel links).
 * Staff approve each claim; only APPROVED skills can be bid on (Part 5).
 */
export const tutorSkills = pgTable(
  'tutor_skills',
  {
    tutorUserId: uuid('tutor_user_id')
      .notNull()
      .references(() => tutorProfiles.userId, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'restrict' }),
    status: tutorSkillStatus('status').notNull().default('PENDING'),
    experienceYears: integer('experience_years'),
    /** What and how they teach for this skill. */
    summary: text('summary').notNull().default(''),
    evidenceLinks: text('evidence_links')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tutorUserId, t.skillId] }),
    index('tutor_skills_skill_status_idx').on(t.skillId, t.status),
    index('tutor_skills_status_idx').on(t.status, t.createdAt),
    check(
      'tutor_skills_experience_years_range',
      sql`${t.experienceYears} is null or ${t.experienceYears} between 0 and 60`,
    ),
  ],
);

export type TutorProfileRow = typeof tutorProfiles.$inferSelect;
export type TutorSkillRow = typeof tutorSkills.$inferSelect;
