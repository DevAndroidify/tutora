import { sql } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from '../identity/identity.schema';

/**
 * Two-level taxonomy: top-level categories (e.g. "Finance & Investing") and optional
 * sub-categories (e.g. "Academics > School Mathematics").
 */
export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parentId: uuid('parent_id'),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('categories_slug_unique').on(t.slug),
    index('categories_parent_id_idx').on(t.parentId),
    foreignKey({ columns: [t.parentId], foreignColumns: [t.id], name: 'categories_parent_fk' }),
  ],
);

/** Something people can learn and teach: "Technical Analysis", "Video Editing", "Calculus". */
export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /**
     * Shown to learners before booking, e.g. "Education only, not investment advice"
     * for stock-market skills.
     */
    learnerNotice: text('learner_notice'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('skills_slug_unique').on(t.slug),
    index('skills_category_id_idx').on(t.categoryId),
    // Trigram index (pg_trgm) so ILIKE '%text%' skill search stays fast as the catalog grows.
    index('skills_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
  ],
);

/** Optional finer topics inside a skill, e.g. Calculus > Integrals. */
export const topics = pgTable(
  'topics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'restrict' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('topics_skill_slug_unique').on(t.skillId, t.slug),
    index('topics_skill_id_idx').on(t.skillId),
  ],
);

export const SUGGESTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];
export const skillSuggestionStatus = pgEnum('skill_suggestion_status', SUGGESTION_STATUSES);

/** Tutors propose skills that are missing from the catalog; staff approve or reject them. */
export const skillSuggestions = pgTable(
  'skill_suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    suggestedBy: uuid('suggested_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    status: skillSuggestionStatus('status').notNull().default('PENDING'),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    createdSkillId: uuid('created_skill_id').references(() => skills.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('skill_suggestions_status_idx').on(t.status, t.createdAt),
    index('skill_suggestions_suggested_by_idx').on(t.suggestedBy),
  ],
);

export type CategoryRow = typeof categories.$inferSelect;
export type SkillRow = typeof skills.$inferSelect;
export type TopicRow = typeof topics.$inferSelect;
export type SkillSuggestionRow = typeof skillSuggestions.$inferSelect;
