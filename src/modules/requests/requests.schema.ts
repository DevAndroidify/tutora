import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { skills, topics } from '../catalog/catalog.schema';
import { users } from '../identity/identity.schema';

export const SKILL_LEVELS = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];

/** Same state machine as the original "doubt". POOLED/RESERVED/BOOKED/COMPLETED come in later parts. */
export const REQUEST_STATUSES = [
  'DRAFT',
  'OPEN',
  'POOLED',
  'RESERVED',
  'BOOKED',
  'COMPLETED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const skillLevel = pgEnum('skill_level', SKILL_LEVELS);
export const requestStatus = pgEnum('learning_request_status', REQUEST_STATUSES);

/** What a learner wants to learn or solve. Tutors bid on OPEN requests for skills they're approved in. */
export const learningRequests = pgTable(
  'learning_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    studentUserId: uuid('student_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id),
    topicId: uuid('topic_id').references(() => topics.id),
    level: skillLevel('level').notNull(),
    title: text('title').notNull(),
    /** Screened: contact details are masked before storing. */
    description: text('description').notNull(),
    preferredLanguage: text('preferred_language'),
    /** Optional budget hint in paise. Never a float. */
    budgetHintPaise: bigint('budget_hint_paise', { mode: 'number' }),
    status: requestStatus('status').notNull().default('DRAFT'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('learning_requests_student_idx').on(t.studentUserId, t.createdAt),
    index('learning_requests_browse_idx').on(t.status, t.skillId, t.publishedAt),
    index('learning_requests_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'OPEN'`),
    check(
      'learning_requests_budget_range',
      sql`${t.budgetHintPaise} is null or (${t.budgetHintPaise} > 0 and ${t.budgetHintPaise} <= 9007199254740991)`,
    ),
    check(
      'learning_requests_open_has_expiry',
      sql`${t.status} <> 'OPEN' or (${t.publishedAt} is not null and ${t.expiresAt} is not null)`,
    ),
  ],
);

export const requestAttachments = pgTable(
  'request_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => learningRequests.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('request_attachments_object_key_unique').on(t.objectKey),
    index('request_attachments_request_idx').on(t.requestId),
  ],
);

export type LearningRequestRow = typeof learningRequests.$inferSelect;
export type RequestAttachmentRow = typeof requestAttachments.$inferSelect;
