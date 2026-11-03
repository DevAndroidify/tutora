import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The three client apps. Each has its own API area (/student, /tutor, /admin)
 * and its own tokens: a token issued to one app is rejected by the others.
 */
export const CLIENT_APPS = ['student', 'tutor', 'admin'] as const;
export type ClientApp = (typeof CLIENT_APPS)[number];
export type MemberApp = Exclude<ClientApp, 'admin'>;

/**
 * MEMBER: a marketplace user. The same account can learn in the student app
 * and teach in the tutor app. STAFF: platform staff, admin app only.
 */
export const ACCOUNT_TYPES = ['MEMBER', 'STAFF'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Staff permissions in the admin app. MODERATOR handles trust & safety (Part 3). */
export const STAFF_ROLES = ['ADMIN', 'MODERATOR'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** SUSPENDED and BANNED are set by moderation (Part 3). Only ACTIVE accounts can sign in. */
export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'BANNED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const clientApp = pgEnum('client_app', CLIENT_APPS);
export const accountType = pgEnum('account_type', ACCOUNT_TYPES);
export const staffRole = pgEnum('staff_role', STAFF_ROLES);
export const userStatus = pgEnum('user_status', USER_STATUSES);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Always stored lower-cased and trimmed. */
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    fullName: text('full_name').notNull(),
    accountType: accountType('account_type').notNull().default('MEMBER'),
    staffRole: staffRole('staff_role'),
    status: userStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(t.email),
    check(
      'users_staff_role_matches_type',
      sql`(${t.accountType} = 'STAFF') = (${t.staffRole} is not null)`,
    ),
  ],
);

export type UserRow = typeof users.$inferSelect;

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The app this sign-in belongs to. A token only refreshes in its own app. */
    app: clientApp('app').notNull(),
    /** All tokens rotated from one sign-in share a family. Reuse revokes the whole family. */
    familyId: uuid('family_id').notNull(),
    /** SHA-256 of the opaque token. The raw token is never stored. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when this token was exchanged for a new one. */
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    replacedById: uuid('replaced_by_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    uniqueIndex('refresh_tokens_token_hash_unique').on(t.tokenHash),
    index('refresh_tokens_user_id_idx').on(t.userId),
    index('refresh_tokens_family_active_idx')
      .on(t.familyId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
