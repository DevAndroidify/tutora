import { Injectable, Module } from '@nestjs/common';
import { and, avg, count, eq, inArray, lte, sql } from 'drizzle-orm';
import { AppConfig } from '../../platform/config/app-config';
import { Clock } from '../../platform/clock/clock';
import { InjectDb, type Database, type DbExecutor } from '../../platform/database/database.module';
import { isUniqueViolation } from '../../platform/database/pg-errors';
import { AppError } from '../../platform/errors/app-error';
import type { AuthUser } from '../../platform/http/request-context';
import { CatalogModule } from '../catalog/catalog.module';
import { CatalogService } from '../catalog/catalog.service';
import { QUESTION_SEED } from './mastery.seed-data';
import {
  questionBank,
  quizAttempts,
  reviews,
  tutorMasteryStats,
  type QuizAttemptRow,
  type QuizKind,
} from './mastery.schema';

const WEIGHT: Record<QuizKind, number> = { EXIT: 1, RECHECK: 2 };
const MIN_BANK = 3;

export interface QuizView {
  id: string;
  sessionId: string;
  kind: QuizKind;
  mode: 'QUIZ' | 'SELF_CHECK';
  status: 'OPEN' | 'SUBMITTED';
  availableAt: string;
  dueAt: string;
  /** Prompts and options only. Answer keys are never sent. */
  questions: Array<{ id: string; prompt: string; options: string[] }>;
  result: { correct: number; total: number; passed: boolean } | null;
}

export interface MasteryView {
  skillId: string;
  /** Null until MASTERY_MIN_ATTEMPTS attempts; show `label` instead. */
  score: number | null;
  label: string;
  attempts: number;
}

export interface SessionOutcomeInput {
  sessionId: string;
  tutorUserId: string;
  skillId: string;
  endedAt: Date;
  participants: Array<{ id: string; studentUserId: string }>;
}

/**
 * Part 13: outcome checks and the tutor Mastery Score.
 *   MasteryScore = (weightedPasses + k * platformAverage) / (weightedAttempts + k)
 * Exit attempts weigh 1, rechecks 2. Quiz results never touch payments.
 */
@Injectable()
export class MasteryService {
  constructor(
    @InjectDb() private readonly db: Database,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly catalog: CatalogService,
  ) {}

  /** Called in the transaction that ends a session: one exit check now, one recheck later, per attendee. */
  async createForSessionInTx(tx: DbExecutor, input: SessionOutcomeInput): Promise<void> {
    const now = this.clock.now();
    const day = 86_400_000;
    const recheckAt = new Date(input.endedAt.getTime() + this.config.env.RECHECK_DAYS * day);
    for (const p of input.participants) {
      for (const [kind, availableAt] of [
        ['EXIT', now],
        ['RECHECK', recheckAt],
      ] as const) {
        const questionIds = await this.pickQuestions(tx, input.skillId);
        await tx
          .insert(quizAttempts)
          .values({
            sessionId: input.sessionId,
            participantId: p.id,
            studentUserId: p.studentUserId,
            tutorUserId: input.tutorUserId,
            skillId: input.skillId,
            kind,
            mode: questionIds.length >= MIN_BANK ? 'QUIZ' : 'SELF_CHECK',
            questionIds: questionIds.length >= MIN_BANK ? questionIds : [],
            availableAt,
            dueAt: new Date(availableAt.getTime() + 3 * day),
            createdAt: now,
          })
          .onConflictDoNothing();
      }
    }
  }

  /** Quizzes the learner can take now (and recent results). */
  async listForStudent(student: AuthUser): Promise<QuizView[]> {
    const rows = await this.db
      .select()
      .from(quizAttempts)
      .where(
        and(
          eq(quizAttempts.studentUserId, student.id),
          lte(quizAttempts.availableAt, this.clock.now()),
        ),
      )
      .orderBy(quizAttempts.availableAt)
      .limit(50);
    return Promise.all(rows.map((r) => this.toView(r)));
  }

  async submit(student: AuthUser, attemptId: string, answers: number[]): Promise<QuizView> {
    return this.db.transaction(async (tx) => {
      const [a] = await tx
        .select()
        .from(quizAttempts)
        .where(eq(quizAttempts.id, attemptId))
        .for('update');
      if (!a || a.studentUserId !== student.id)
        throw AppError.notFound('QUIZ_NOT_FOUND', 'Quiz not found.');
      const now = this.clock.now();
      if (a.status !== 'OPEN')
        throw AppError.conflict('QUIZ_ALREADY_SUBMITTED', 'This quiz was already submitted.');
      if (a.availableAt > now)
        throw AppError.conflict('QUIZ_NOT_AVAILABLE', 'This quiz is not available yet.');
      if (a.dueAt <= now) throw AppError.conflict('QUIZ_EXPIRED', 'This quiz has expired.');

      let correct: number;
      let total: number;
      if (a.mode === 'QUIZ') {
        if (answers.length !== a.questionIds.length) {
          throw AppError.badRequest(
            'ANSWER_COUNT',
            `Answer all ${a.questionIds.length} questions.`,
          );
        }
        const keys = await tx
          .select({ id: questionBank.id, correctIndex: questionBank.correctIndex })
          .from(questionBank)
          .where(inArray(questionBank.id, a.questionIds));
        const byId = new Map(keys.map((k) => [k.id, k.correctIndex]));
        correct = a.questionIds.filter((qid, i) => byId.get(qid) === answers[i]).length;
        total = a.questionIds.length;
      } else {
        const rating = answers[0];
        if (answers.length !== 1 || !Number.isInteger(rating) || rating! < 1 || rating! > 5) {
          throw AppError.badRequest(
            'SELF_CHECK_RATING',
            'Rate how well you can now do this, from 1 to 5.',
          );
        }
        correct = rating!;
        total = 5;
      }
      const passed =
        a.mode === 'QUIZ'
          ? correct * 100 >= total * this.config.env.QUIZ_PASS_PERCENT
          : correct >= 4;

      const [updated] = await tx
        .update(quizAttempts)
        .set({
          status: 'SUBMITTED',
          answers,
          correctCount: correct,
          totalCount: total,
          passed,
          submittedAt: now,
        })
        .where(and(eq(quizAttempts.id, a.id), eq(quizAttempts.status, 'OPEN')))
        .returning();
      const w = WEIGHT[a.kind];
      await tx
        .insert(tutorMasteryStats)
        .values({
          tutorUserId: a.tutorUserId,
          skillId: a.skillId,
          attempts: 1,
          weightedAttempts: w,
          weightedPasses: passed ? w : 0,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [tutorMasteryStats.tutorUserId, tutorMasteryStats.skillId],
          set: {
            attempts: sql`${tutorMasteryStats.attempts} + 1`,
            weightedAttempts: sql`${tutorMasteryStats.weightedAttempts} + ${w}`,
            weightedPasses: sql`${tutorMasteryStats.weightedPasses} + ${passed ? w : 0}`,
            updatedAt: now,
          },
        });
      return this.toView(updated!, tx);
    });
  }

  /** Mastery per (tutor, skill). Platform average is the weighted pass rate of all tutors in the skill. */
  async scores(tutorIds: string[], skillId: string): Promise<Map<string, MasteryView>> {
    const out = new Map<string, MasteryView>();
    if (tutorIds.length === 0) return out;
    const [platform] = await this.db
      .select({
        wp: sql<string>`coalesce(sum(${tutorMasteryStats.weightedPasses}), 0)`,
        wa: sql<string>`coalesce(sum(${tutorMasteryStats.weightedAttempts}), 0)`,
      })
      .from(tutorMasteryStats)
      .where(eq(tutorMasteryStats.skillId, skillId));
    const wa = Number(platform?.wa ?? 0);
    const platformAvg = wa > 0 ? Number(platform!.wp) / wa : 0.5;
    const k = this.config.env.MASTERY_K;
    const rows = await this.db
      .select()
      .from(tutorMasteryStats)
      .where(
        and(
          eq(tutorMasteryStats.skillId, skillId),
          inArray(tutorMasteryStats.tutorUserId, tutorIds),
        ),
      );
    const byTutor = new Map(rows.map((r) => [r.tutorUserId, r]));
    for (const id of tutorIds) {
      const r = byTutor.get(id);
      const attempts = r?.attempts ?? 0;
      const raw = ((r?.weightedPasses ?? 0) + k * platformAvg) / ((r?.weightedAttempts ?? 0) + k);
      const visible = attempts >= this.config.env.MASTERY_MIN_ATTEMPTS;
      out.set(id, {
        skillId,
        score: visible ? Math.round(raw * 1000) / 1000 : null,
        label: visible ? `${Math.round(raw * 100)}% mastery` : 'New tutor',
        attempts,
      });
    }
    return out;
  }

  // ---------- Reviews ----------

  async addReview(input: {
    sessionId: string;
    participantId: string;
    studentUserId: string;
    tutorUserId: string;
    skillId: string;
    rating: number;
    comment: string;
  }) {
    try {
      const [row] = await this.db
        .insert(reviews)
        .values({ ...input, createdAt: this.clock.now() })
        .returning();
      return {
        id: row!.id,
        rating: row!.rating,
        comment: row!.comment,
        createdAt: row!.createdAt.toISOString(),
      };
    } catch (err) {
      if (isUniqueViolation(err))
        throw AppError.conflict('ALREADY_REVIEWED', 'You already reviewed this session.');
      throw err;
    }
  }

  async ratings(
    tutorIds: string[],
  ): Promise<Map<string, { average: number | null; count: number }>> {
    if (tutorIds.length === 0) return new Map();
    const rows = await this.db
      .select({ tutorUserId: reviews.tutorUserId, avg: avg(reviews.rating), n: count() })
      .from(reviews)
      .where(inArray(reviews.tutorUserId, tutorIds))
      .groupBy(reviews.tutorUserId);
    return new Map(
      rows.map((r) => [
        r.tutorUserId,
        { average: r.avg ? Math.round(Number(r.avg) * 10) / 10 : null, count: r.n },
      ]),
    );
  }

  // ---------- Seed ----------

  async seedQuestions(): Promise<number> {
    let n = 0;
    for (const [slug, questions] of Object.entries(QUESTION_SEED)) {
      const skill = await this.catalog.getSkill(slug).catch(() => null);
      if (!skill) continue;
      for (const [prompt, options, correctIndex] of questions) {
        await this.db
          .insert(questionBank)
          .values({ skillId: skill.id, prompt, options, correctIndex })
          .onConflictDoUpdate({
            target: [questionBank.skillId, questionBank.prompt],
            set: { options, correctIndex },
          });
        n++;
      }
    }
    return n;
  }

  // ---------- Helpers ----------

  private async pickQuestions(tx: DbExecutor, skillId: string): Promise<string[]> {
    const rows = await tx
      .select({ id: questionBank.id })
      .from(questionBank)
      .where(and(eq(questionBank.skillId, skillId), eq(questionBank.isActive, true)))
      .orderBy(sql`random()`)
      .limit(this.config.env.QUIZ_QUESTIONS);
    return rows.map((r) => r.id);
  }

  private async toView(a: QuizAttemptRow, tx: DbExecutor = this.db): Promise<QuizView> {
    const qs = a.questionIds.length
      ? await tx
          .select({
            id: questionBank.id,
            prompt: questionBank.prompt,
            options: questionBank.options,
          })
          .from(questionBank)
          .where(inArray(questionBank.id, a.questionIds))
      : [];
    const byId = new Map(qs.map((q) => [q.id, q]));
    return {
      id: a.id,
      sessionId: a.sessionId,
      kind: a.kind,
      mode: a.mode,
      status: a.status,
      availableAt: a.availableAt.toISOString(),
      dueAt: a.dueAt.toISOString(),
      questions:
        a.mode === 'QUIZ'
          ? a.questionIds.map((id) => byId.get(id)!).filter(Boolean)
          : [
              {
                id: 'self-check',
                prompt: 'How confidently can you now do what you came to learn? (1-5)',
                options: ['1', '2', '3', '4', '5'],
              },
            ],
      result:
        a.status === 'SUBMITTED'
          ? { correct: a.correctCount ?? 0, total: a.totalCount ?? 0, passed: a.passed ?? false }
          : null,
    };
  }
}

@Module({
  imports: [CatalogModule],
  providers: [MasteryService],
  exports: [MasteryService],
})
export class MasteryModule {}
