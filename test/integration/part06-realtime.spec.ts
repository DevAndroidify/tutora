import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { OutboxService } from '../../src/platform/outbox/outbox.service';
import { outboxEvents } from '../../src/platform/outbox/outbox.schema';
import { DRIZZLE, type Database } from '../../src/platform/database/database.module';
import { RealtimeRouter, RealtimeRouterModule } from '../../src/modules/realtime/realtime.router';
import { approvedTutor, bidBody, openRequest, publishOutbox } from '../fixtures/marketplace';
import {
  bearer,
  createStaff,
  createTestApp,
  login,
  registerMember,
  resetState,
  seedCatalog,
  type Session,
  type TestApp,
} from '../fixtures/test-app';

type Received = Array<{ event: string; data: unknown }>;

describe('Part 6: outbox and realtime', () => {
  let t: TestApp;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    t = await createTestApp({ imports: [RealtimeRouterModule], listen: true });
    const { port } = t.app.getHttpServer().address() as AddressInfo;
    url = `http://127.0.0.1:${port}/realtime`;
  });

  beforeEach(async () => {
    await resetState(t);
    await seedCatalog(t);
  });

  afterEach(() => {
    sockets.splice(0).forEach((s) => s.disconnect());
  });

  afterAll(async () => {
    await t.close();
  });

  /** Connects with an access token and records every event it receives. */
  async function connect(session: {
    accessToken: string;
  }): Promise<{ socket: Socket; received: Received }> {
    const socket = io(url, {
      auth: { token: session.accessToken },
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(socket);
    const received: Received = [];
    socket.onAny((event, data) => received.push({ event, data }));
    await new Promise<void>((resolve, reject) => {
      socket.once('ready', () => resolve());
      socket.once('connect_error', reject);
      socket.once('disconnect', () => reject(new Error('disconnected')));
    });
    return { socket, received };
  }

  const subscribe = (socket: Socket, room: string) =>
    socket.emitWithAck('subscribe', { room }) as Promise<{ ok: boolean; error?: string }>;

  /** Delivers outbox events, then waits until the condition holds (events travel via Redis). */
  async function deliverUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
    await publishOutbox(t);
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for realtime events');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  describe('transactional outbox', () => {
    it('a rolled-back change publishes no event', async () => {
      const db = t.app.get<Database>(DRIZZLE);
      const outbox = t.app.get(OutboxService);
      await expect(
        db.transaction(async (tx) => {
          await outbox.add(tx, 'bid.created', { requestId: 'x' });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await db.select().from(outboxEvents)).toHaveLength(0);

      // A rejected bid (no active request) also writes nothing.
      const tutor = await approvedTutor(t);
      await t.http
        .post('/tutor/requests/00000000-0000-4000-8000-000000000000/bids')
        .set(bearer(tutor))
        .send(bidBody(t))
        .expect(404);
      expect(await db.select().from(outboxEvents)).toHaveLength(0);
    });

    it('a crash or restart does not lose pending events; delivery retries and is idempotent', async () => {
      const student = await registerMember(t, 'student');
      const requestId = await openRequest(t, student);
      const tutor = await approvedTutor(t);
      await t.http
        .post(`/tutor/requests/${requestId}/bids`)
        .set(bearer(tutor))
        .send(bidBody(t))
        .expect(201);

      const outbox = t.app.get(OutboxService);
      expect(await outbox.pendingCount()).toBe(2); // request.published + bid.created

      // Worker dies mid-delivery: nothing is marked published.
      await outbox.publishPending(async () => {
        throw new Error('worker crashed');
      });
      expect(await outbox.pendingCount()).toBe(2);

      // A "restarted" worker picks them up after the backoff.
      t.clock.advanceMinutes(1);
      const router = t.app.get(RealtimeRouter);
      expect(await outbox.publishPending((e) => router.handle(e))).toBe(2);
      expect(await outbox.pendingCount()).toBe(0);

      const notes = await t.http.get('/student/notifications').set(bearer(student)).expect(200);
      expect(notes.body.map((n: { type: string }) => n.type)).toEqual(['bid.received']);
      // Re-delivering the same event does not duplicate the notification.
      const [ev] = await t.app.get<Database>(DRIZZLE).select().from(outboxEvents);
      await router.handle({ id: ev!.id, type: ev!.eventType, payload: ev!.payload, createdAt: '' });
      expect(
        (await t.http.get('/student/notifications').set(bearer(student)).expect(200)).body,
      ).toHaveLength(1);
    });
  });

  describe('Socket.IO', () => {
    let student: Session;
    let tutorA: Session;
    let tutorB: Session;
    let requestId: string;

    beforeEach(async () => {
      const admin = await createStaff(t);
      student = await registerMember(t, 'student');
      requestId = await openRequest(t, student);
      tutorA = await approvedTutor(t, ['technical-analysis'], 'Tutor A', admin);
      tutorB = await approvedTutor(t, ['technical-analysis'], 'Tutor B', admin);
      await publishOutbox(t);
    });

    it('the learner gets full bids; rival tutors only get the bid count, never a price', async () => {
      const owner = await connect(student);
      const a = await connect(tutorA);
      const b = await connect(tutorB);
      expect(await subscribe(owner.socket, `request:${requestId}:owner`)).toEqual({
        ok: true,
        room: `request:${requestId}:owner`,
      });
      expect((await subscribe(a.socket, `request:${requestId}:tutors`)).ok).toBe(true);
      expect((await subscribe(b.socket, `request:${requestId}:tutors`)).ok).toBe(true);

      await t.http
        .post(`/tutor/requests/${requestId}/bids`)
        .set(bearer(tutorA))
        .send(bidBody(t, { seatPricePaise: 88800 }))
        .expect(201);

      await deliverUntil(
        () =>
          owner.received.some((r) => r.event === 'bid.created') &&
          b.received.some((r) => r.event === 'request.bid_count_changed') &&
          owner.received.some((r) => r.event === 'notification.created'),
      );

      const ownerBid = owner.received.find((r) => r.event === 'bid.created')!.data as {
        bid: { seatPricePaise: number };
        bidCount: number;
      };
      expect(ownerBid).toMatchObject({ bidCount: 1, bid: { seatPricePaise: 88800 } });
      // Joined both the user room and the owner room, but receives the event once.
      expect(owner.received.filter((r) => r.event === 'bid.created')).toHaveLength(1);

      expect(b.received.find((r) => r.event === 'request.bid_count_changed')!.data).toMatchObject({
        requestId,
        bidCount: 1,
      });
      expect(b.received.map((r) => r.event)).not.toContain('bid.created');
      expect(JSON.stringify(b.received)).not.toContain('88800');
      expect(JSON.stringify(b.received)).not.toContain('seatPricePaise');

      // The bidder sees their own bid.
      await new Promise((r) => setTimeout(r, 100));
      expect(a.received.find((r) => r.event === 'bid.created')).toBeDefined();
    });

    it('closing a request is announced to the owner and to tutors', async () => {
      const owner = await connect(student);
      const b = await connect(tutorB);
      await subscribe(b.socket, `request:${requestId}:tutors`);
      await t.http.post(`/student/requests/${requestId}/cancel`).set(bearer(student)).expect(200);
      await deliverUntil(
        () =>
          owner.received.some((r) => r.event === 'request.closed') &&
          b.received.some((r) => r.event === 'request.closed'),
      );
      expect(b.received.find((r) => r.event === 'request.closed')!.data).toMatchObject({
        requestId,
        status: 'CANCELLED',
      });
    });

    it("unauthorized users can't join private rooms", async () => {
      const otherStudent = await connect(await registerMember(t, 'student'));
      expect(await subscribe(otherStudent.socket, `request:${requestId}:owner`)).toEqual({
        ok: false,
        error: 'FORBIDDEN',
      });
      expect(await subscribe(otherStudent.socket, `request:${requestId}:tutors`)).toEqual({
        ok: false,
        error: 'FORBIDDEN',
      });

      const tutor = await connect(tutorA);
      expect(await subscribe(tutor.socket, `request:${requestId}:owner`)).toEqual({
        ok: false,
        error: 'FORBIDDEN',
      });

      const editor = await connect(await approvedTutor(t, ['video-editing'], 'Editor'));
      expect(await subscribe(editor.socket, `request:${requestId}:tutors`)).toEqual({
        ok: false,
        error: 'FORBIDDEN',
      });

      // The owner signed in to the tutor app is still not an eligible tutor for their own request.
      const ownerAsTutor = await connect(await login(t, 'tutor', student));
      expect(await subscribe(ownerAsTutor.socket, `request:${requestId}:tutors`)).toEqual({
        ok: false,
        error: 'FORBIDDEN',
      });

      expect(await subscribe(tutor.socket, 'admin:moderation')).toEqual({
        ok: false,
        error: 'UNKNOWN_ROOM',
      });
      expect(await subscribe(tutor.socket, `user:student:${student.userId}`)).toEqual({
        ok: false,
        error: 'UNKNOWN_ROOM',
      });
    });

    it('rejects connections without a valid token', async () => {
      const socket = io(url, {
        auth: { token: 'garbage' },
        transports: ['websocket'],
        forceNew: true,
      });
      sockets.push(socket);
      const err = await new Promise<{ code: string }>((resolve) => socket.once('error', resolve));
      expect(err.code).toBe('UNAUTHENTICATED');
      await new Promise<void>((resolve) =>
        socket.connected ? socket.once('disconnect', () => resolve()) : resolve(),
      );
      expect(socket.connected).toBe(false);
    });
  });
});
