import { eq } from 'drizzle-orm';
import { recordings } from '../../src/modules/recording/recording.schema';
import { RecordingProvider } from '../../src/providers/livekit/livekit.service';
import { StorageService } from '../../src/platform/storage/storage.service';
import { goToStart, joined, paidSession, relogin, sendLivekit, type PaidSession } from './live';
import { bearer, type TestApp } from './test-app';

/** Stands in for LiveKit Egress. */
export class FakeRecordingProvider extends RecordingProvider {
  n = 0;
  async start() {
    this.n++;
    return { egressId: `EG_test_${Date.now()}_${this.n}` };
  }
  async stop() {}
}

export interface Recorded extends PaidSession {
  recordingId: string;
  objectKey: string;
}

/**
 * A live session that both people consented to record, with Egress reporting the file complete.
 * Optionally stores a sample transcript next to the recording for the fake transcriber.
 */
export async function recordedSession(
  t: TestApp,
  transcript?: Array<{ startMs: number; endMs: number; speaker: string; text: string }>,
): Promise<Recorded> {
  let s = await paidSession(t);
  await goToStart(t, s);
  await sendLivekit(t, joined(s.sessionId, `tutor:${s.tutor.userId}`));
  s = await relogin(t, s);
  await t.http
    .post(`/student/sessions/${s.sessionId}/consent`)
    .set(bearer(s.student))
    .send({ granted: true })
    .expect(200);
  await t.http
    .post(`/tutor/sessions/${s.sessionId}/consent`)
    .set(bearer(s.tutor))
    .send({ granted: true })
    .expect(200);
  const [rec] = await t.db.select().from(recordings).where(eq(recordings.sessionId, s.sessionId));
  if (transcript) {
    await t.app
      .get(StorageService)
      .putText(`${rec!.objectKey}.transcript.json`, JSON.stringify(transcript));
  }
  await sendLivekit(t, {
    event: 'egress_ended',
    egressInfo: { egressId: rec!.egressId, status: 'EGRESS_COMPLETE' },
  });
  return { ...s, recordingId: rec!.id, objectKey: rec!.objectKey };
}
