import { eq } from 'drizzle-orm';
import { poolInvites } from '../../src/modules/pooling/pooling.schema';
import { PoolingService } from '../../src/modules/pooling/pooling.service';
import { learningRequests } from '../../src/modules/requests/requests.schema';
import { EmbeddingProvider } from '../../src/providers/embeddings/embedding.provider';
import { openRequest } from '../fixtures/marketplace';
import {
  bearer,
  createTestApp,
  registerMember,
  resetState,
  seedCatalog,
  type Session,
  type TestApp,
} from '../fixtures/test-app';

const SIMILAR = [
  'How do I identify a bullish engulfing candlestick pattern on daily charts',
  'Identify bullish engulfing candlestick pattern on daily charts, I keep missing it',
  'Bullish engulfing candlestick pattern on daily charts: how do I identify it',
];
const DIFFERENT = 'Position sizing and stop loss rules for intraday futures trading';

describe('Part 18: request pooling', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await resetState(t);
    await seedCatalog(t);
  });

  afterAll(async () => {
    await t.close();
  });

  async function publish(student: Session, title: string, overrides: Record<string, unknown> = {}) {
    const id = await openRequest(t, student, 'technical-analysis', {
      title: title.slice(0, 140),
      description: title,
      ...overrides,
    });
    await t.app.get(PoolingService).processRequest(id);
    return id;
  }

  it('pools three similar requests and leaves the different one out', async () => {
    const students = await Promise.all([1, 2, 3, 4].map(() => registerMember(t, 'student')));
    const ids = [
      await publish(students[0]!, SIMILAR[0]!),
      await publish(students[1]!, SIMILAR[1]!),
      await publish(students[2]!, SIMILAR[2]!),
      await publish(students[3]!, DIFFERENT),
    ];
    const invites = await t.db.select().from(poolInvites);
    const pooled = new Set(invites.map((i) => i.requestId));
    expect(pooled).toEqual(new Set(ids.slice(0, 3)));
    expect(new Set(invites.map((i) => i.poolId)).size).toBe(1);
    expect(invites.every((i) => i.status === 'INVITED' && i.matchedBy === 'EMBEDDING')).toBe(true);
  });

  it('only matches the same skill and level', async () => {
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => registerMember(t, 'student')));
    await publish(a!, SIMILAR[0]!);
    await publish(b!, SIMILAR[1]!, { level: 'ADVANCED' }); // same text, different level
    const otherSkill = await openRequest(t, c!, 'fundamental-analysis', {
      title: SIMILAR[2]!,
      description: SIMILAR[2]!,
    });
    await t.app.get(PoolingService).processRequest(otherSkill);
    expect(await t.db.select().from(poolInvites)).toHaveLength(0);
  });

  it('nobody joins without opting in; accepting moves the request to POOLED', async () => {
    const [a, b] = await Promise.all([1, 2].map(() => registerMember(t, 'student')));
    const ra = await publish(a!, SIMILAR[0]!);
    await publish(b!, SIMILAR[1]!);
    for (const id of [ra]) {
      const [req] = await t.db.select().from(learningRequests).where(eq(learningRequests.id, id));
      expect(req!.status).toBe('OPEN'); // invited, not joined
    }
    const [invite] = (await t.http.get('/student/pools/invites').set(bearer(a!)).expect(200)).body;
    expect(invite).toMatchObject({
      status: 'INVITED',
      requestId: ra,
      pool: { joined: 0, invited: 2, level: 'BEGINNER' },
    });

    const accepted = await t.http
      .post(`/student/pools/invites/${invite.id}/accept`)
      .set(bearer(a!))
      .expect(200);
    expect(accepted.body).toMatchObject({ status: 'ACCEPTED', pool: { joined: 1 } });
    const [req] = await t.db.select().from(learningRequests).where(eq(learningRequests.id, ra));
    expect(req!.status).toBe('POOLED');

    // Others can't act on my invite; a declined invite can't be accepted.
    const [bInvite] = (await t.http.get('/student/pools/invites').set(bearer(b!)).expect(200)).body;
    await t.http.post(`/student/pools/invites/${bInvite.id}/accept`).set(bearer(a!)).expect(404);
    await t.http.post(`/student/pools/invites/${bInvite.id}/decline`).set(bearer(b!)).expect(200);
    await t.http.post(`/student/pools/invites/${bInvite.id}/accept`).set(bearer(b!)).expect(409);
  });

  it('invitations never reveal other learners', async () => {
    const [a, b] = await Promise.all([
      registerMember(t, 'student', { fullName: 'Secret Person One' }),
      registerMember(t, 'student', { fullName: 'Secret Person Two' }),
    ]);
    await publish(a!, SIMILAR[0]!);
    const rb = await publish(b!, SIMILAR[1]!);
    const body = JSON.stringify(
      (await t.http.get('/student/pools/invites').set(bearer(a!)).expect(200)).body,
    );
    for (const leak of ['Secret Person Two', b!.email, b!.userId, rb, 'keep missing it']) {
      expect(body).not.toContain(leak);
    }
  });
});

describe('Part 18: embedding provider failure falls back to the same topic', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      overrides: [
        {
          provide: EmbeddingProvider,
          useValue: {
            model: 'down',
            embed: async () => {
              throw new Error('embeddings unavailable');
            },
          },
        },
      ],
    });
  });

  beforeEach(async () => {
    await resetState(t);
    await seedCatalog(t);
  });

  afterAll(async () => {
    await t.close();
  });

  it('pools requests with the same topic_id when embeddings are unavailable', async () => {
    const detail = await t.http.get('/public/skills/technical-analysis').expect(200);
    const [topicA, topicB] = detail.body.topics.map((x: { id: string }) => x.id);
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => registerMember(t, 'student')));
    const pooling = t.app.get(PoolingService);
    const ra = await openRequest(t, a!, 'technical-analysis', {
      topicId: topicA,
      title: 'Patterns help',
      description: 'Anything about patterns',
    });
    const rb = await openRequest(t, b!, 'technical-analysis', {
      topicId: topicA,
      title: 'Totally different words',
      description: 'Hammer and doji',
    });
    const rc = await openRequest(t, c!, 'technical-analysis', {
      topicId: topicB,
      title: 'Patterns help',
      description: 'Anything about patterns',
    });
    for (const id of [ra, rb, rc]) await pooling.processRequest(id);
    const invites = await t.db.select().from(poolInvites);
    expect(new Set(invites.map((i) => i.requestId))).toEqual(new Set([ra, rb]));
    expect(invites.every((i) => i.matchedBy === 'TOPIC' && i.similarity === null)).toBe(true);
  });
});
