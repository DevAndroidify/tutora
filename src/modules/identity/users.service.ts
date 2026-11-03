import { Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { Clock } from '../../platform/clock/clock';
import { InjectDb, type Database, type DbExecutor } from '../../platform/database/database.module';
import { isUniqueViolation } from '../../platform/database/pg-errors';
import { AppError } from '../../platform/errors/app-error';
import { users, type AccountType, type StaffRole, type UserRow } from './identity.schema';

/** What the API returns about a user. Never includes the password hash. */
export interface UserView {
  id: string;
  email: string;
  fullName: string;
  accountType: AccountType;
  staffRole: StaffRole | null;
  status: UserRow['status'];
  createdAt: string;
}

/** Minimal identity other modules may show publicly (e.g. a tutor's name). Never the email. */
export interface PublicUser {
  id: string;
  fullName: string;
}

/** Contact details for staff tools only (review queues). */
export interface UserContact {
  id: string;
  fullName: string;
  email: string;
  status: UserRow['status'];
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toUserView(row: UserRow): UserView {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    accountType: row.accountType,
    staffRole: row.staffRole,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Owns the `users` table. Other modules call this service instead of querying users.
 */
@Injectable()
export class UsersService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  async findById(id: string, tx: DbExecutor = this.db): Promise<UserRow | null> {
    const [row] = await tx.select().from(users).where(eq(users.id, id));
    return row ?? null;
  }

  async findByEmail(email: string, tx: DbExecutor = this.db): Promise<UserRow | null> {
    const [row] = await tx
      .select()
      .from(users)
      .where(eq(users.email, normalizeEmail(email)));
    return row ?? null;
  }

  async getPublicUsers(ids: string[]): Promise<Map<string, PublicUser>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ id: users.id, fullName: users.fullName })
      .from(users)
      .where(inArray(users.id, [...new Set(ids)]));
    return new Map(rows.map((r) => [r.id, r]));
  }

  async getContacts(ids: string[]): Promise<Map<string, UserContact>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ id: users.id, fullName: users.fullName, email: users.email, status: users.status })
      .from(users)
      .where(inArray(users.id, [...new Set(ids)]));
    return new Map(rows.map((r) => [r.id, r]));
  }

  async createMember(
    input: { email: string; passwordHash: string; fullName: string },
    tx: DbExecutor = this.db,
  ): Promise<UserRow> {
    return this.insert({ ...input, accountType: 'MEMBER', staffRole: null }, tx);
  }

  async createStaff(
    input: { email: string; passwordHash: string; fullName: string; staffRole: StaffRole },
    tx: DbExecutor = this.db,
  ): Promise<UserRow> {
    return this.insert({ ...input, accountType: 'STAFF' }, tx);
  }

  /** Used by moderation (suspend / ban / reinstate). Returns false if the user does not exist. */
  async setStatus(
    userId: string,
    status: UserRow['status'],
    tx: DbExecutor = this.db,
  ): Promise<boolean> {
    const rows = await tx
      .update(users)
      .set({ status, updatedAt: this.clock.now() })
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    return rows.length > 0;
  }

  private async insert(
    input: {
      email: string;
      passwordHash: string;
      fullName: string;
      accountType: AccountType;
      staffRole: StaffRole | null;
    },
    tx: DbExecutor,
  ): Promise<UserRow> {
    const now = this.clock.now();
    try {
      const [row] = await tx
        .insert(users)
        .values({
          email: normalizeEmail(input.email),
          passwordHash: input.passwordHash,
          fullName: input.fullName.trim(),
          accountType: input.accountType,
          staffRole: input.staffRole,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return row!;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw AppError.conflict(
          'EMAIL_TAKEN',
          'An account with this email already exists. Sign in instead; one account works in both the student and tutor apps.',
        );
      }
      throw err;
    }
  }
}
