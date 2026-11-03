import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { clientApp, users } from '../identity/identity.schema';

export const SCREENING_RULES = [
  'CONTACT_PHONE',
  'CONTACT_EMAIL',
  'CONTACT_UPI',
  'CONTACT_SOCIAL',
  'OFF_PLATFORM_PAYMENT',
  'ABUSIVE_LANGUAGE',
  'FINANCIAL_TIP',
] as const;
export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const SCREENING_ACTIONS = ['MASK', 'FLAG', 'BLOCK'] as const;

export const REPORT_REASONS = [
  'HARASSMENT',
  'OFF_PLATFORM_PAYMENT',
  'NO_SHOW',
  'MISLEADING_CLAIMS',
  'INAPPROPRIATE_CONTENT',
  'FINANCIAL_TIPS',
  'SPAM',
  'OTHER',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const CASE_STATUSES = ['OPEN', 'ACTIONED', 'DISMISSED'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** What staff can do with a case. DISMISS closes it with no sanction. */
export const MODERATION_ACTIONS = [
  'DISMISS',
  'WARN',
  'RESTRICT_POSTING',
  'RESTRICT_BIDDING',
  'SUSPEND',
  'BAN',
] as const;
export type ModerationActionType = (typeof MODERATION_ACTIONS)[number];

export const SANCTION_TYPES = [
  'WARN',
  'RESTRICT_POSTING',
  'RESTRICT_BIDDING',
  'SUSPEND',
  'BAN',
] as const;
export type SanctionType = (typeof SANCTION_TYPES)[number];

/** Where the content lives. Extend as new user-written content appears. */
export const ENTITY_TYPES = [
  'USER',
  'TUTOR_PROFILE',
  'TUTOR_SKILL',
  'LEARNING_REQUEST',
  'BID',
  'SESSION',
] as const;
export type ModeratedEntity = (typeof ENTITY_TYPES)[number];

export const screeningRule = pgEnum('screening_rule', SCREENING_RULES);
export const severity = pgEnum('moderation_severity', SEVERITIES);
export const screeningAction = pgEnum('screening_action', SCREENING_ACTIONS);
export const reportReason = pgEnum('report_reason', REPORT_REASONS);
export const caseStatus = pgEnum('moderation_case_status', CASE_STATUSES);
export const moderationActionType = pgEnum('moderation_action_type', MODERATION_ACTIONS);
export const sanctionType = pgEnum('sanction_type', SANCTION_TYPES);
export const moderatedEntity = pgEnum('moderated_entity', ENTITY_TYPES);

/** One open case per member at a time; flags and reports about them collect there. */
export const moderationCases = pgTable(
  'moderation_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectUserId: uuid('subject_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: caseStatus('status').notNull().default('OPEN'),
    /** Sum of severity weights of everything attached. Higher is reviewed first. */
    priority: integer('priority').notNull().default(0),
    assignedTo: uuid('assigned_to'),
    resolution: text('resolution'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('moderation_cases_one_open_per_user')
      .on(t.subjectUserId)
      .where(sql`${t.status} = 'OPEN'`),
    index('moderation_cases_queue_idx').on(t.status, t.priority, t.lastActivityAt),
  ],
);

/** Automated screening hits. */
export const contentFlags = pgTable(
  'content_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    entityType: moderatedEntity('entity_type').notNull(),
    entityId: text('entity_id'),
    field: text('field').notNull(),
    rule: screeningRule('rule').notNull(),
    severity: severity('severity').notNull(),
    action: screeningAction('action').notNull(),
    excerpt: text('excerpt').notNull(),
    caseId: uuid('case_id').references(() => moderationCases.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('content_flags_user_idx').on(t.userId, t.createdAt),
    index('content_flags_case_idx').on(t.caseId),
  ],
);

/** Member reports about other members. */
export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reporterUserId: uuid('reporter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    subjectUserId: uuid('subject_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: reportReason('reason').notNull(),
    entityType: moderatedEntity('entity_type'),
    entityId: text('entity_id'),
    details: text('details').notNull().default(''),
    reportedFromApp: clientApp('reported_from_app').notNull(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => moderationCases.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('reports_case_idx').on(t.caseId),
    index('reports_reporter_idx').on(t.reporterUserId, t.createdAt),
  ],
);

/** Staff decisions on cases. Append-only (trigger). */
export const moderationActions = pgTable(
  'moderation_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => moderationCases.id),
    actorUserId: uuid('actor_user_id').notNull(),
    action: moderationActionType('action').notNull(),
    reason: text('reason').notNull(),
    durationDays: integer('duration_days'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('moderation_actions_case_idx').on(t.caseId)],
);

/** Active and past penalties on a member. Time-limited ones are lifted by a worker sweep. */
export const userSanctions = pgTable(
  'user_sanctions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: sanctionType('type').notNull(),
    caseId: uuid('case_id').references(() => moderationCases.id),
    reason: text('reason').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    /** Null = permanent (BAN) or not time-bound (WARN). */
    endsAt: timestamp('ends_at', { withTimezone: true }),
    liftedAt: timestamp('lifted_at', { withTimezone: true }),
    liftedBy: uuid('lifted_by'),
    liftReason: text('lift_reason'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('user_sanctions_active_idx')
      .on(t.userId, t.type)
      .where(sql`${t.liftedAt} is null`),
    index('user_sanctions_expiry_idx')
      .on(t.endsAt)
      .where(sql`${t.liftedAt} is null and ${t.endsAt} is not null`),
  ],
);

export type ModerationCaseRow = typeof moderationCases.$inferSelect;
export type UserSanctionRow = typeof userSanctions.$inferSelect;
