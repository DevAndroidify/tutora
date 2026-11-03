import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { AuditService } from '../../platform/audit/audit.service';
import { Clock } from '../../platform/clock/clock';
import { InjectDb, type Database, type DbExecutor } from '../../platform/database/database.module';
import { isUniqueViolation } from '../../platform/database/pg-errors';
import { AppError } from '../../platform/errors/app-error';
import { auditActor, type AuthUser } from '../../platform/http/request-context';
import { CATALOG_SEED, type SeedCategory } from './catalog.seed-data';
import {
  categories,
  skills,
  skillSuggestions,
  topics,
  type CategoryRow,
  type SkillRow,
  type SkillSuggestionRow,
  type SuggestionStatus,
  type TopicRow,
} from './catalog.schema';

// ---------- Views ----------

export interface CategoryView {
  id: string;
  parentId: string | null;
  slug: string;
  name: string;
  description: string;
  isActive: boolean;
}

export interface CategoryTreeView extends CategoryView {
  children: CategoryView[];
}

export interface SkillView {
  id: string;
  categoryId: string;
  slug: string;
  name: string;
  description: string;
  learnerNotice: string | null;
  isActive: boolean;
}

export interface TopicView {
  id: string;
  skillId: string;
  slug: string;
  name: string;
  isActive: boolean;
}

export interface SkillDetailView extends SkillView {
  category: CategoryView;
  topics: TopicView[];
}

export interface SuggestionView {
  id: string;
  suggestedBy: string;
  categoryId: string;
  name: string;
  description: string;
  status: SuggestionStatus;
  decisionNote: string | null;
  decidedAt: string | null;
  createdSkillId: string | null;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string): boolean => UUID.test(v);

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const toCategory = (c: CategoryRow): CategoryView => ({
  id: c.id,
  parentId: c.parentId,
  slug: c.slug,
  name: c.name,
  description: c.description,
  isActive: c.isActive,
});

const toSkill = (s: SkillRow): SkillView => ({
  id: s.id,
  categoryId: s.categoryId,
  slug: s.slug,
  name: s.name,
  description: s.description,
  learnerNotice: s.learnerNotice,
  isActive: s.isActive,
});

const toTopic = (t: TopicRow): TopicView => ({
  id: t.id,
  skillId: t.skillId,
  slug: t.slug,
  name: t.name,
  isActive: t.isActive,
});

const toSuggestion = (s: SkillSuggestionRow): SuggestionView => ({
  id: s.id,
  suggestedBy: s.suggestedBy,
  categoryId: s.categoryId,
  name: s.name,
  description: s.description,
  status: s.status,
  decisionNote: s.decisionNote,
  decidedAt: s.decidedAt?.toISOString() ?? null,
  createdSkillId: s.createdSkillId,
  createdAt: s.createdAt.toISOString(),
});

function slugConflict(err: unknown): never {
  if (isUniqueViolation(err)) {
    throw AppError.conflict('SLUG_TAKEN', 'Another item already uses this slug.');
  }
  throw err;
}

/**
 * Owns `categories`, `skills`, `topics` and `skill_suggestions`.
 * Public reads only return active items; staff reads include inactive ones.
 */
@Injectable()
export class CatalogService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  // ================= Public reads =================

  /** Active top-level categories, each with its active sub-categories. */
  async categoryTree(): Promise<CategoryTreeView[]> {
    const rows = await this.db
      .select()
      .from(categories)
      .where(eq(categories.isActive, true))
      .orderBy(asc(categories.sortOrder), asc(categories.name));
    const top = rows.filter((c) => c.parentId === null);
    return top.map((c) => ({
      ...toCategory(c),
      children: rows.filter((child) => child.parentId === c.id).map(toCategory),
    }));
  }

  /**
   * Searches active skills by name/description, optionally inside a category
   * (a top-level category includes its sub-categories).
   */
  async searchSkills(input: {
    q?: string;
    categoryId?: string;
    limit: number;
    offset: number;
    includeInactive?: boolean;
  }): Promise<Page<SkillView>> {
    const filters: SQL[] = [];
    if (!input.includeInactive) filters.push(eq(skills.isActive, true));
    if (input.q) {
      const pattern = `%${escapeLike(input.q.trim())}%`;
      filters.push(or(ilike(skills.name, pattern), ilike(skills.description, pattern))!);
    }
    if (input.categoryId) {
      const ids = await this.categoryAndChildren(input.categoryId);
      filters.push(inArray(skills.categoryId, ids));
    }
    const where = filters.length ? and(...filters) : undefined;

    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(skills)
        .where(where)
        .orderBy(asc(skills.name))
        .limit(input.limit)
        .offset(input.offset),
      this.db.select({ n: count() }).from(skills).where(where),
    ]);
    return {
      items: rows.map(toSkill),
      total: total?.n ?? 0,
      limit: input.limit,
      offset: input.offset,
    };
  }

  /** An active skill by id or slug, with its category and active topics. */
  async getSkill(idOrSlug: string): Promise<SkillDetailView> {
    const match = isUuid(idOrSlug) ? eq(skills.id, idOrSlug) : eq(skills.slug, idOrSlug);
    const [row] = await this.db
      .select({ skill: skills, category: categories })
      .from(skills)
      .innerJoin(categories, eq(categories.id, skills.categoryId))
      .where(and(match, eq(skills.isActive, true)));
    if (!row) throw AppError.notFound('SKILL_NOT_FOUND', 'Skill not found.');

    const topicRows = await this.db
      .select()
      .from(topics)
      .where(and(eq(topics.skillId, row.skill.id), eq(topics.isActive, true)))
      .orderBy(asc(topics.sortOrder), asc(topics.name));
    return {
      ...toSkill(row.skill),
      category: toCategory(row.category),
      topics: topicRows.map(toTopic),
    };
  }

  /** Active skills among `ids`. Used by other modules to validate references. */
  async findActiveSkills(ids: string[]): Promise<SkillView[]> {
    const valid = [...new Set(ids)].filter(isUuid);
    if (valid.length === 0) return [];
    const rows = await this.db
      .select()
      .from(skills)
      .where(and(inArray(skills.id, valid), eq(skills.isActive, true)));
    return rows.map(toSkill);
  }

  /** Skills by id regardless of status (for showing history, e.g. a tutor's past skills). */
  async findSkills(ids: string[]): Promise<Map<string, SkillView>> {
    const valid = [...new Set(ids)].filter(isUuid);
    if (valid.length === 0) return new Map();
    const rows = await this.db.select().from(skills).where(inArray(skills.id, valid));
    return new Map(rows.map((r) => [r.id, toSkill(r)]));
  }

  private async categoryAndChildren(categoryId: string): Promise<string[]> {
    if (!isUuid(categoryId)) return [];
    const rows = await this.db
      .select({ id: categories.id })
      .from(categories)
      .where(or(eq(categories.id, categoryId), eq(categories.parentId, categoryId)));
    return rows.length ? rows.map((r) => r.id) : [categoryId];
  }

  // ================= Tutor: skill suggestions =================

  async suggestSkill(
    user: AuthUser,
    input: { categoryId: string; name: string; description?: string },
  ): Promise<SuggestionView> {
    await this.requireActiveCategory(input.categoryId);
    const existing = await this.db
      .select({ id: skills.id, slug: skills.slug })
      .from(skills)
      .where(
        or(
          sql`lower(${skills.name}) = lower(${input.name.trim()})`,
          eq(skills.slug, slugify(input.name)),
        ),
      );
    if (existing[0]) {
      throw AppError.conflict('SKILL_EXISTS', 'This skill is already in the catalog.', {
        skillId: existing[0].id,
        slug: existing[0].slug,
      });
    }
    const pending = await this.db
      .select({ n: count() })
      .from(skillSuggestions)
      .where(
        and(eq(skillSuggestions.suggestedBy, user.id), eq(skillSuggestions.status, 'PENDING')),
      );
    if ((pending[0]?.n ?? 0) >= 10) {
      throw AppError.conflict(
        'TOO_MANY_PENDING_SUGGESTIONS',
        'You already have 10 suggestions waiting for review.',
      );
    }

    const [row] = await this.db
      .insert(skillSuggestions)
      .values({
        suggestedBy: user.id,
        categoryId: input.categoryId,
        name: input.name.trim(),
        description: input.description?.trim() ?? '',
        createdAt: this.clock.now(),
      })
      .returning();
    return toSuggestion(row!);
  }

  async listOwnSuggestions(user: AuthUser): Promise<SuggestionView[]> {
    const rows = await this.db
      .select()
      .from(skillSuggestions)
      .where(eq(skillSuggestions.suggestedBy, user.id))
      .orderBy(desc(skillSuggestions.createdAt))
      .limit(100);
    return rows.map(toSuggestion);
  }

  // ================= Staff: catalog management =================

  async listAllCategories(): Promise<CategoryView[]> {
    const rows = await this.db
      .select()
      .from(categories)
      .orderBy(asc(categories.sortOrder), asc(categories.name));
    return rows.map(toCategory);
  }

  async createCategory(
    staff: AuthUser,
    input: {
      name: string;
      slug?: string;
      description?: string;
      parentId?: string;
      sortOrder?: number;
    },
    requestId: string | null,
  ): Promise<CategoryView> {
    if (input.parentId) {
      const parent = await this.requireCategory(input.parentId);
      if (parent.parentId) {
        throw AppError.badRequest(
          'CATEGORY_TOO_DEEP',
          'Categories can only be two levels deep. Pick a top-level parent.',
        );
      }
    }
    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const [row] = await tx
        .insert(categories)
        .values({
          name: input.name.trim(),
          slug: input.slug ?? slugify(input.name),
          description: input.description ?? '',
          parentId: input.parentId ?? null,
          sortOrder: input.sortOrder ?? 0,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .catch(slugConflict);
      await this.audit.record(
        {
          actor: auditActor(staff),
          action: 'catalog.category.created',
          entityType: 'category',
          entityId: row!.id,
          metadata: { name: row!.name, slug: row!.slug, parentId: row!.parentId },
          requestId,
        },
        tx,
      );
      return toCategory(row!);
    });
  }

  async updateCategory(
    staff: AuthUser,
    id: string,
    input: { name?: string; description?: string; sortOrder?: number; isActive?: boolean },
    requestId: string | null,
  ): Promise<CategoryView> {
    await this.requireCategory(id);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(categories)
        .set({ ...input, updatedAt: this.clock.now() })
        .where(eq(categories.id, id))
        .returning();
      await this.audit.record(
        {
          actor: auditActor(staff),
          action: 'catalog.category.updated',
          entityType: 'category',
          entityId: id,
          metadata: { changes: input },
          requestId,
        },
        tx,
      );
      return toCategory(row!);
    });
  }

  async createSkill(
    staff: AuthUser,
    input: {
      categoryId: string;
      name: string;
      slug?: string;
      description?: string;
      learnerNotice?: string;
    },
    requestId: string | null,
  ): Promise<SkillView> {
    await this.requireActiveCategory(input.categoryId);
    return this.db.transaction(async (tx) => {
      const row = await this.insertSkill(tx, input);
      await this.audit.record(
        {
          actor: auditActor(staff),
          action: 'catalog.skill.created',
          entityType: 'skill',
          entityId: row.id,
          metadata: { name: row.name, slug: row.slug, categoryId: row.categoryId },
          requestId,
        },
        tx,
      );
      return toSkill(row);
    });
  }

  async updateSkill(
    staff: AuthUser,
    id: string,
    input: {
      categoryId?: string;
      name?: string;
      description?: string;
      learnerNotice?: string | null;
      isActive?: boolean;
    },
    requestId: string | null,
  ): Promise<SkillView> {
    if (input.categoryId) await this.requireActiveCategory(input.categoryId);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(skills)
        .set({ ...input, updatedAt: this.clock.now() })
        .where(eq(skills.id, id))
        .returning();
      if (!row) throw AppError.notFound('SKILL_NOT_FOUND', 'Skill not found.');
      await this.audit.record(
        {
          actor: auditActor(staff),
          action: 'catalog.skill.updated',
          entityType: 'skill',
          entityId: id,
          metadata: { changes: input },
          requestId,
        },
        tx,
      );
      return toSkill(row);
    });
  }

  async createTopic(
    staff: AuthUser,
    skillId: string,
    input: { name: string; slug?: string; sortOrder?: number },
    requestId: string | null,
  ): Promise<TopicView> {
    const [skill] = await this.db
      .select({ id: skills.id })
      .from(skills)
      .where(eq(skills.id, skillId));
    if (!skill) throw AppError.notFound('SKILL_NOT_FOUND', 'Skill not found.');
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(topics)
        .values({
          skillId,
          name: input.name.trim(),
          slug: input.slug ?? slugify(input.name),
          sortOrder: input.sortOrder ?? 0,
          createdAt: this.clock.now(),
        })
        .returning()
        .catch(slugConflict);
      await this.audit.record(
        {
          actor: auditActor(staff),
          action: 'catalog.topic.created',
          entityType: 'topic',
          entityId: row!.id,
          metadata: { skillId, name: row!.name },
          requestId,
        },
        tx,
      );
      return toTopic(row!);
    });
  }

  async listSuggestions(status: SuggestionStatus): Promise<SuggestionView[]> {
    const rows = await this.db
      .select()
      .from(skillSuggestions)
      .where(eq(skillSuggestions.status, status))
      .orderBy(asc(skillSuggestions.createdAt))
      .limit(200);
    return rows.map(toSuggestion);
  }

  /** PENDING -> APPROVED. Creates the skill (staff may adjust name/slug/category) in the same transaction. */
  async approveSuggestion(
    staff: AuthUser,
    id: string,
    input: {
      name?: string;
      slug?: string;
      categoryId?: string;
      learnerNotice?: string;
      note?: string;
    },
    requestId: string | null,
  ): Promise<SuggestionView> {
    const suggestion = await this.requireSuggestion(id);
    const categoryId = input.categoryId ?? suggestion.categoryId;
    await this.requireActiveCategory(categoryId);

    return this.db.transaction(async (tx) => {
      const skill = await this.insertSkill(tx, {
        categoryId,
        name: input.name ?? suggestion.name,
        slug: input.slug,
        description: suggestion.description,
        learnerNotice: input.learnerNotice,
      });
      const [row] = await tx
        .update(skillSuggestions)
        .set({
          status: 'APPROVED',
          decidedBy: staff.id,
          decidedAt: this.clock.now(),
          decisionNote: input.note ?? null,
          createdSkillId: skill.id,
        })
        .where(and(eq(skillSuggestions.id, id), eq(skillSuggestions.status, 'PENDING')))
        .returning();
      if (!row) throw this.notPending(suggestion.status);

      await this.audit.record(
        {
          actor: auditActor(staff),
          action: 'catalog.suggestion.approved',
          entityType: 'skill_suggestion',
          entityId: id,
          metadata: { skillId: skill.id, skillSlug: skill.slug },
          requestId,
        },
        tx,
      );
      return toSuggestion(row);
    });
  }

  /** PENDING -> REJECTED. */
  async rejectSuggestion(
    staff: AuthUser,
    id: string,
    note: string,
    requestId: string | null,
  ): Promise<SuggestionView> {
    const suggestion = await this.requireSuggestion(id);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(skillSuggestions)
        .set({
          status: 'REJECTED',
          decidedBy: staff.id,
          decidedAt: this.clock.now(),
          decisionNote: note,
        })
        .where(and(eq(skillSuggestions.id, id), eq(skillSuggestions.status, 'PENDING')))
        .returning();
      if (!row) throw this.notPending(suggestion.status);
      await this.audit.record(
        {
          actor: auditActor(staff),
          action: 'catalog.suggestion.rejected',
          entityType: 'skill_suggestion',
          entityId: id,
          metadata: { note },
          requestId,
        },
        tx,
      );
      return toSuggestion(row);
    });
  }

  // ================= Seed =================

  /** Inserts or updates the starter catalog. Safe to run repeatedly. */
  async seed(): Promise<{ categories: number; skills: number; topics: number }> {
    const totals = { categories: 0, skills: 0, topics: 0 };
    await this.db.transaction(async (tx) => {
      const upsertCategory = async (c: SeedCategory, parentId: string | null, order: number) => {
        const [row] = await tx
          .insert(categories)
          .values({
            slug: c.slug,
            name: c.name,
            description: c.description,
            parentId,
            sortOrder: order,
          })
          .onConflictDoUpdate({
            target: categories.slug,
            set: {
              name: sql`excluded.name`,
              description: sql`excluded.description`,
              parentId: sql`excluded.parent_id`,
              sortOrder: sql`excluded.sort_order`,
            },
          })
          .returning({ id: categories.id });
        totals.categories++;

        for (const s of c.skills ?? []) {
          const [skill] = await tx
            .insert(skills)
            .values({
              categoryId: row!.id,
              slug: s.slug,
              name: s.name,
              description: s.description,
              learnerNotice: s.learnerNotice ?? null,
            })
            .onConflictDoUpdate({
              target: skills.slug,
              set: {
                categoryId: sql`excluded.category_id`,
                name: sql`excluded.name`,
                description: sql`excluded.description`,
                learnerNotice: sql`excluded.learner_notice`,
              },
            })
            .returning({ id: skills.id });
          totals.skills++;

          for (const [i, [slug, name]] of (s.topics ?? []).entries()) {
            await tx
              .insert(topics)
              .values({ skillId: skill!.id, slug, name, sortOrder: i })
              .onConflictDoUpdate({
                target: [topics.skillId, topics.slug],
                set: { name: sql`excluded.name`, sortOrder: sql`excluded.sort_order` },
              });
            totals.topics++;
          }
        }
        for (const [i, child] of (c.children ?? []).entries()) {
          await upsertCategory(child, row!.id, i);
        }
      };

      for (const [i, c] of CATALOG_SEED.entries()) {
        await upsertCategory(c, null, i);
      }
    });
    return totals;
  }

  // ================= Helpers =================

  private async insertSkill(
    tx: DbExecutor,
    input: {
      categoryId: string;
      name: string;
      slug?: string;
      description?: string;
      learnerNotice?: string;
    },
  ): Promise<SkillRow> {
    const now = this.clock.now();
    const slug = input.slug ?? slugify(input.name);
    if (!slug) throw AppError.badRequest('INVALID_SLUG', 'Could not build a slug from this name.');
    const [row] = await tx
      .insert(skills)
      .values({
        categoryId: input.categoryId,
        name: input.name.trim(),
        slug,
        description: input.description ?? '',
        learnerNotice: input.learnerNotice ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .catch(slugConflict);
    return row!;
  }

  private async requireCategory(id: string): Promise<CategoryRow> {
    const [row] = isUuid(id)
      ? await this.db.select().from(categories).where(eq(categories.id, id))
      : [];
    if (!row) throw AppError.notFound('CATEGORY_NOT_FOUND', 'Category not found.');
    return row;
  }

  private async requireActiveCategory(id: string): Promise<CategoryRow> {
    const row = await this.requireCategory(id);
    if (!row.isActive)
      throw AppError.badRequest('CATEGORY_INACTIVE', 'This category is not active.');
    return row;
  }

  private async requireSuggestion(id: string): Promise<SkillSuggestionRow> {
    const [row] = isUuid(id)
      ? await this.db.select().from(skillSuggestions).where(eq(skillSuggestions.id, id))
      : [];
    if (!row) throw AppError.notFound('SUGGESTION_NOT_FOUND', 'Suggestion not found.');
    return row;
  }

  private notPending(status: SuggestionStatus): AppError {
    return AppError.conflict(
      'INVALID_SUGGESTION_STATE',
      `Only PENDING suggestions can be decided. This one is ${status}.`,
      { status },
    );
  }
}
