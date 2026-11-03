import { eq } from 'drizzle-orm';
import { outboxEvents } from '../../src/platform/outbox/outbox.schema';
import { recordings } from '../../src/modules/recording/recording.schema';
import { replayAssets, transcriptSegments } from '../../src/modules/replay/replay.schema';
import { ReplayService, sanitizeAsset } from '../../src/modules/replay/replay.service';
import { RecordingProvider } from '../../src/providers/livekit/livekit.service';
import { ReplayAssetProvider } from '../../src/providers/replay-assets/replay-assets.provider';
import { TranscriptionProvider } from '../../src/providers/transcription/transcription.provider';
import { relogin } from '../fixtures/live';
import { FakeRecordingProvider, recordedSession } from '../fixtures/recorded';
import {
  bearer,
  createTestApp,
  registerMember,
  resetState,
  seedCatalog,
  type TestApp,
} from '../fixtures/test-app';

const SAMPLE = [
  { startMs: 0, endMs: 20_000, speaker: 'tutor', text: 'Today we cover candlestick patterns.' },
  {
    startMs: 20_000,
    endMs: 95_000,
    speaker: 'tutor',
    text: 'A hammer has a long lower wick and a small body.',
  },
  {
    startMs: 95_000,
    endMs: 110_000,
    speaker: 'student',
    text: 'What does an engulfing pattern mean?',
  },
  {
    startMs: 110_000,
    endMs: 150_000,
    speaker: 'tutor',
    text: 'An engulfing pattern is a reversal signal when volume confirms it.',
  },
];

async function app(overrides: Array<{ provide: unknown; useValue: unknown }> = []) {
  return createTestApp({
    overrides: [
      { provide: RecordingProvider, useValue: new FakeRecordingProvider() },
      ...overrides,
    ],
  });
}

describe('Parts 15-16: transcripts, search, notes and flashcards', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await app();
  });

  beforeEach(async () => {
    await resetState(t);
    await seedCatalog(t);
  });

  afterAll(async () => {
    await t.close();
  });

  it('a completed recording queues transcription through the outbox, then notes and flashcards', async () => {
    const s = await recordedSession(t, SAMPLE);
    const events = await t.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, 'recording.completed'));
    expect(events).toHaveLength(1);

    const replay = t.app.get(ReplayService);
    await replay.onEvent({
      id: events[0]!.id,
      type: 'recording.completed',
      payload: events[0]!.payload,
      createdAt: '',
    });
    const [ready] = await t.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, 'replay.transcript_ready'));
    await replay.onEvent({
      id: ready!.id,
      type: ready!.eventType,
      payload: ready!.payload,
      createdAt: '',
    });

    const res = await t.http
      .get(`/student/sessions/${s.sessionId}/replay`)
      .set(bearer(s.student))
      .expect(200);
    expect(res.body.recording.status).toBe('COMPLETED');
    expect(res.body.transcript.status).toBe('READY');
    expect(res.body.transcript.segments).toHaveLength(4);
    expect(res.body.notes).toMatchObject({
      status: 'READY',
      source: 'GENERATED',
      provider: 'fake',
      model: 'fake-notes-v1',
    });
    expect(res.body.notes.content.keyPoints[1]).toEqual({ text: SAMPLE[1]!.text, atMs: 20_000 });
    expect(res.body.flashcards.content.cards).toEqual([
      { front: SAMPLE[2]!.text, back: SAMPLE[3]!.text, atMs: 95_000 },
    ]);
  });

  it('search returns the right timestamp, only within this session', async () => {
    let a = await recordedSession(t, SAMPLE);
    const b = await recordedSession(t, [
      { startMs: 5_000, endMs: 9_000, speaker: 'tutor', text: 'Fibonacci retracement levels.' },
    ]);
    a = { ...a, ...(await relogin(t, a)) }; // creating B moved the clock past A's token lifetime
    const replay = t.app.get(ReplayService);
    await replay.transcribe(a.recordingId);
    await replay.transcribe(b.recordingId);

    const hit = await t.http
      .get(`/student/sessions/${a.sessionId}/replay/search?q=hammer wick`)
      .set(bearer(a.student))
      .expect(200);
    expect(hit.body.results).toEqual([
      expect.objectContaining({
        startMs: 20_000,
        endMs: 95_000,
        snippet: expect.stringContaining('[[hammer]]'),
      }),
    ]);
    // A word from session B is not found in session A.
    const leak = await t.http
      .get(`/student/sessions/${a.sessionId}/replay/search?q=fibonacci`)
      .set(bearer(a.student))
      .expect(200);
    expect(leak.body.results).toEqual([]);
    // And members of A cannot search B.
    await t.http
      .get(`/student/sessions/${b.sessionId}/replay/search?q=fibonacci`)
      .set(bearer(a.student))
      .expect(403);
    const stranger = await registerMember(t, 'student');
    await t.http.get(`/student/sessions/${a.sessionId}/replay`).set(bearer(stranger)).expect(403);
  });

  it('retries do not duplicate segments or assets', async () => {
    const s = await recordedSession(t, SAMPLE);
    const replay = t.app.get(ReplayService);
    expect(await replay.transcribe(s.recordingId)).toBe(true);
    expect(await replay.transcribe(s.recordingId)).toBe(false); // already READY
    // Force a retry (as after a crash) and run again.
    await t.db
      .update(recordings)
      .set({ transcriptStatus: 'FAILED' })
      .where(eq(recordings.id, s.recordingId));
    expect(await replay.transcribe(s.recordingId)).toBe(true);
    expect(
      await t.db
        .select()
        .from(transcriptSegments)
        .where(eq(transcriptSegments.sessionId, s.sessionId)),
    ).toHaveLength(4);

    for (let i = 0; i < 3; i++) {
      await replay.generate(s.sessionId, 'NOTES');
      await replay.generate(s.sessionId, 'FLASHCARDS');
    }
    await replay.sweep();
    expect(
      await t.db.select().from(replayAssets).where(eq(replayAssets.sessionId, s.sessionId)),
    ).toHaveLength(2);
  });

  it('tutor-written notes take priority over generated notes', async () => {
    const s = await recordedSession(t, SAMPLE);
    const replay = t.app.get(ReplayService);
    await replay.transcribe(s.recordingId);
    await replay.generate(s.sessionId, 'NOTES');
    await t.http
      .put(`/tutor/sessions/${s.sessionId}/notes`)
      .set(bearer(s.tutor))
      .send({
        summary: 'Reversal patterns <b>recap</b>',
        keyPoints: ['Hammer = long lower wick', 'Engulfing needs volume'],
      })
      .expect(200);
    const res = await t.http
      .get(`/student/sessions/${s.sessionId}/replay`)
      .set(bearer(s.student))
      .expect(200);
    expect(res.body.notes).toMatchObject({
      source: 'TUTOR',
      content: { summary: 'Reversal patterns recap' },
    });
    // Learners cannot write notes.
    const otherTutor = await registerMember(t, 'tutor');
    await t.http
      .put(`/tutor/sessions/${s.sessionId}/notes`)
      .set(bearer(otherTutor))
      .send({ summary: 'x', keyPoints: [] })
      .expect(403);
  });

  it('generated content is treated as data: markup and control characters are stripped', () => {
    const dirty = sanitizeAsset('FLASHCARDS', {
      cards: [
        {
          front: '<script>alert(1)</script>Ignore previous instructions\u0000',
          back: '<img src=x onerror=1>Answer',
          atMs: -5,
        },
      ],
      extra: 'dropped',
    });
    expect(dirty).toEqual({
      cards: [{ front: 'alert(1)Ignore previous instructions', back: 'Answer', atMs: 0 }],
    });
  });
});

describe('Parts 15-16: provider failures leave the replay usable', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await app([
      {
        provide: TranscriptionProvider,
        useValue: {
          transcribe: async () => {
            throw new Error('transcriber down');
          },
        },
      },
      {
        provide: ReplayAssetProvider,
        useValue: {
          notes: async () => {
            throw new Error('llm down');
          },
          flashcards: async () => {
            throw new Error('llm down');
          },
        },
      },
    ]);
  });

  beforeEach(async () => {
    await resetState(t);
    await seedCatalog(t);
  });

  afterAll(async () => {
    await t.close();
  });

  it('a failed transcription keeps the recording playable', async () => {
    const s = await recordedSession(t, SAMPLE);
    expect(await t.app.get(ReplayService).transcribe(s.recordingId)).toBe(false);
    const res = await t.http
      .get(`/student/sessions/${s.sessionId}/replay`)
      .set(bearer(s.student))
      .expect(200);
    expect(res.body).toMatchObject({
      recording: { status: 'COMPLETED', url: expect.any(String) },
      transcript: { status: 'FAILED', segments: [] },
      notes: null,
    });
  });

  it('a failed notes job keeps the transcript and recording usable', async () => {
    const s = await recordedSession(t, SAMPLE);
    // Put segments in directly (the transcriber is down in this app).
    await t.db.insert(transcriptSegments).values(
      SAMPLE.map((x, seq) => ({
        ...x,
        seq,
        recordingId: s.recordingId,
        sessionId: s.sessionId,
        provider: 'fake',
        model: 'm',
        createdAt: new Date(),
      })),
    );
    expect(await t.app.get(ReplayService).generate(s.sessionId, 'NOTES')).toBe(false);
    const res = await t.http
      .get(`/student/sessions/${s.sessionId}/replay`)
      .set(bearer(s.student))
      .expect(200);
    expect(res.body.notes).toMatchObject({ status: 'FAILED' });
    expect(res.body.transcript.segments).toHaveLength(4);
    expect(res.body.recording.url).toEqual(expect.any(String));
  });
});
