import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { LedgerService } from '../../src/modules/ledger/ledger.service';
import { tutorMasteryStats } from '../../src/modules/mastery/mastery.schema';
import { MasteryService } from '../../src/modules/mastery/mastery.service';
import {
  finished,
  goToStart,
  joined,
  paidSession,
  relogin,
  sendLivekit,
  type PaidSession,
} from '../fixtures/live';
import { approvedTutor, bidBody, openRequest } from '../fixtures/marketplace';
import {
  bearer,
  createStaff,
  createTestApp,
  login,
  registerMember,
  resetState,
  seedCatalog,
  skillId,
  type TestApp,
} from '../fixtures/test-app';

describe('Part 13: quizzes and Mastery Score', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await resetState(t);
    await seedCatalog(t);
    await t.app.get(MasteryService).seedQuestions();
  });

  afterAll(async () => {
    await t.close();
  });

  async function attended(): Promise<PaidSession> {
    const s = await paidSession(t);
    await goToStart(t, s);
    await sendLivekit(t, joined(s.sessionId, `tutor:${s.tutor.userId}`));
    await sendLivekit(t, joined(s.sessionId, `student:${s.student.userId}`));
    t.clock.advanceMinutes(60);
    await sendLivekit(t, finished(s.sessionId));
    return relogin(t, s);
  }

  it('creates an exit quiz now and a recheck 7 days later, without answer keys', async () => {
    const s = await attended();
    const quizzes = await t.http.get('/student/quizzes').set(bearer(s.student)).expect(200);
    expect(quizzes.body).toHaveLength(1);
    const quiz = quizzes.body[0];
    expect(quiz).toMatchObject({ kind: 'EXIT', mode: 'QUIZ', status: 'OPEN' });
    expect(quiz.questions).toHaveLength(t.config.env.QUIZ_QUESTIONS);
    const raw = JSON.stringify(quizzes.body);
    expect(raw).not.toMatch(/correct/i);

    const submitted = await t.http
      .post(`/student/quizzes/${quiz.id}/submit`)
      .set(bearer(s.student))
      .send({ answers: quiz.questions.map(() => 0) })
      .expect(200);
    expect(submitted.body.result).toEqual({
      correct: expect.any(Number),
      total: 5,
      passed: expect.any(Boolean),
    });
    expect(JSON.stringify(submitted.body)).not.toMatch(/correctIndex/);
    await t.http
      .post(`/student/quizzes/${quiz.id}/submit`)
      .set(bearer(s.student))
      .send({ answers: [0, 0, 0, 0, 0] })
      .expect(409);

    t.clock.advanceDays(t.config.env.RECHECK_DAYS);
    const later = await login(t, 'student', s.student);
    const after = await t.http.get('/student/quizzes').set(bearer(later)).expect(200);
    expect(
      after.body.map((q: { kind: string; status: string }) => `${q.kind}:${q.status}`),
    ).toEqual(['EXIT:SUBMITTED', 'RECHECK:OPEN']);
  });

  it('seeded data gives the expected score, and scores stay hidden until 10 attempts', async () => {
    const skill = await skillId(t, 'technical-analysis');
    const admin = await createStaff(t);
    const [a, b, c] = await Promise.all(
      ['A', 'B', 'C'].map((n) => approvedTutor(t, ['technical-analysis'], `Tutor ${n}`, admin)),
    );
    const now = new Date();
    await t.db.insert(tutorMasteryStats).values([
      {
        tutorUserId: a!.userId,
        skillId: skill,
        attempts: 10,
        weightedAttempts: 14,
        weightedPasses: 12,
        updatedAt: now,
      },
      {
        tutorUserId: b!.userId,
        skillId: skill,
        attempts: 10,
        weightedAttempts: 14,
        weightedPasses: 4,
        updatedAt: now,
      },
      {
        tutorUserId: c!.userId,
        skillId: skill,
        attempts: 9,
        weightedAttempts: 12,
        weightedPasses: 12,
        updatedAt: now,
      },
    ]);
    // platformAverage = (12 + 4 + 12) / (14 + 14 + 12) = 0.7; k = 10.
    const scores = await t.app.get(MasteryService).scores([a!.userId, b!.userId, c!.userId], skill);
    expect(scores.get(a!.userId)).toMatchObject({
      score: Number(((12 + 7) / 24).toFixed(3)),
      attempts: 10,
    });
    expect(scores.get(b!.userId)!.score).toBeCloseTo((4 + 7) / 24, 3);
    expect(scores.get(c!.userId)).toEqual({
      skillId: skill,
      score: null,
      label: 'New tutor',
      attempts: 9,
    });

    const pub = await t.http.get(`/public/tutors/${c!.userId}`).expect(200);
    expect(pub.body.skills[0].mastery).toMatchObject({ score: null, label: 'New tutor' });
    expect(
      (await t.http.get(`/public/tutors/${a!.userId}`).expect(200)).body.skills[0].mastery.label,
    ).toBe('79% mastery');

    // Mastery feeds the M input of bid ranking: A outranks B at the same price and time.
    const student = await registerMember(t, 'student');
    const requestId = await openRequest(t, student);
    const start = new Date(t.clock.nowMs() + 3 * 3_600_000).toISOString();
    for (const tutor of [b!, a!]) {
      await t.http
        .post(`/tutor/requests/${requestId}/bids`)
        .set(bearer(tutor))
        .send(bidBody(t, { proposedStartAt: start }))
        .expect(201);
    }
    const ranked = await t.http
      .get(`/student/requests/${requestId}/bids`)
      .set(bearer(student))
      .expect(200);
    expect(ranked.body.map((x: { tutor: { fullName: string } }) => x.tutor.fullName)).toEqual([
      'Tutor A',
      'Tutor B',
    ]);
    expect(ranked.body[0].score.components[0]).toMatchObject({ key: 'M', placeholder: false });
  });

  it('quiz results never change ledger balances', async () => {
    const s = await attended();
    const ledger = t.app.get(LedgerService);
    const before = await ledger.balances();
    const [quiz] = (await t.http.get('/student/quizzes').set(bearer(s.student)).expect(200)).body;
    await t.http
      .post(`/student/quizzes/${quiz.id}/submit`)
      .set(bearer(s.student))
      .send({ answers: [1, 1, 1, 1, 1] })
      .expect(200);
    expect(await ledger.balances()).toEqual(before);
    const [stats] = await t.db
      .select()
      .from(tutorMasteryStats)
      .where(eq(tutorMasteryStats.tutorUserId, s.tutor.userId));
    expect(stats).toMatchObject({ attempts: 1, weightedAttempts: 1 });
  });

  it('skills without a question bank use a 1-5 self-check', async () => {
    const svc = t.app.get(MasteryService);
    const student = await registerMember(t, 'student');
    const tutor = await registerMember(t, 'tutor');
    // Video editing has no seeded question bank.
    const editingId = await skillId(t, 'video-editing');
    await t.db.transaction((tx) =>
      svc.createForSessionInTx(tx, {
        sessionId: randomUUID(),
        tutorUserId: tutor.userId,
        skillId: editingId,
        endedAt: t.clock.now(),
        participants: [{ id: randomUUID(), studentUserId: student.userId }],
      }),
    );
    const [quiz] = (await t.http.get('/student/quizzes').set(bearer(student)).expect(200)).body;
    expect(quiz).toMatchObject({ mode: 'SELF_CHECK' });
    await t.http
      .post(`/student/quizzes/${quiz.id}/submit`)
      .set(bearer(student))
      .send({ answers: [9] })
      .expect(400);
    const res = await t.http
      .post(`/student/quizzes/${quiz.id}/submit`)
      .set(bearer(student))
      .send({ answers: [4] })
      .expect(200);
    expect(res.body.result).toEqual({ correct: 4, total: 5, passed: true });
  });

  it('attendees can review once; the rating shows on the public profile', async () => {
    const s = await attended();
    await t.http
      .post(`/student/sessions/${s.sessionId}/review`)
      .set(bearer(s.student))
      .send({ rating: 5, comment: 'Very clear explanations.' })
      .expect(201);
    await t.http
      .post(`/student/sessions/${s.sessionId}/review`)
      .set(bearer(s.student))
      .send({ rating: 1 })
      .expect(409);
    const pub = await t.http.get(`/public/tutors/${s.tutor.userId}`).expect(200);
    expect(pub.body.rating).toEqual({ average: 5, count: 1 });
  });
});
