import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { skills, topics } from '../catalog/catalog.schema';
import { users } from '../identity/identity.schema';

export const QUIZ_KINDS = ['EXIT', 'RECHECK'] as const;
export type QuizKind = (typeof QUIZ_KINDS)[number];
/** QUIZ: multiple choice from the skill's question bank. SELF_CHECK: 1-5 self-rating where no bank exists. */
export const QUIZ_MODES = ['QUIZ', 'SELF_CHECK'] as const;
export type QuizMode = (typeof QUIZ_MODES)[number];
export const ATTEMPT_STATUSES = ['OPEN', 'SUBMITTED'] as const;

export const quizKind = pgEnum('quiz_kind', QUIZ_KINDS);
export const quizMode = pgEnum('quiz_mode', QUIZ_MODES);
export const attemptStatus = pgEnum('quiz_attempt_status', ATTEMPT_STATUSES);

/** Multiple-choice questions per skill. `correct_index` is never sent to clients. */
export const questionBank = pgTable(
  'question_bank',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id),
    topicId: uuid('topic_id').references(() => topics.id),
    prompt: text('prompt').notNull(),
    options: text('options').array().notNull(),
    correctIndex: smallint('correct_index').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('question_bank_skill_prompt_unique').on(t.skillId, t.prompt),
    check(
      'question_bank_correct_index_range',
      sql`${t.correctIndex} >= 0 and ${t.correctIndex} < cardinality(${t.options}) and cardinality(${t.options}) between 2 and 6`,
    ),
  ],
);

/** One exit quiz right after the session and one recheck RECHECK_DAYS later, per learner. */
export const quizAttempts = pgTable(
  'quiz_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull(),
    participantId: uuid('participant_id').notNull(),
    studentUserId: uuid('student_user_id')
      .notNull()
      .references(() => users.id),
    tutorUserId: uuid('tutor_user_id')
      .notNull()
      .references(() => users.id),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id),
    kind: quizKind('kind').notNull(),
    mode: quizMode('mode').notNull(),
    status: attemptStatus('status').notNull().default('OPEN'),
    questionIds: uuid('question_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    answers: integer('answers').array(),
    correctCount: integer('correct_count'),
    totalCount: integer('total_count'),
    passed: boolean('passed'),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('quiz_attempts_participant_kind_unique').on(t.participantId, t.kind),
    index('quiz_attempts_student_idx').on(t.studentUserId, t.status),
  ],
);

/** Running totals per tutor and skill. Exit attempts weigh 1, rechecks 2. */
export const tutorMasteryStats = pgTable(
  'tutor_mastery_stats',
  {
    tutorUserId: uuid('tutor_user_id')
      .notNull()
      .references(() => users.id),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id),
    attempts: integer('attempts').notNull().default(0),
    weightedAttempts: integer('weighted_attempts').notNull().default(0),
    weightedPasses: integer('weighted_passes').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tutorUserId, t.skillId] })],
);

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull(),
    participantId: uuid('participant_id').notNull(),
    studentUserId: uuid('student_user_id')
      .notNull()
      .references(() => users.id),
    tutorUserId: uuid('tutor_user_id')
      .notNull()
      .references(() => users.id),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id),
    rating: smallint('rating').notNull(),
    comment: text('comment').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('reviews_participant_unique').on(t.participantId),
    index('reviews_tutor_idx').on(t.tutorUserId),
    check('reviews_rating_range', sql`${t.rating} between 1 and 5`),
  ],
);

export type QuizAttemptRow = typeof quizAttempts.$inferSelect;
