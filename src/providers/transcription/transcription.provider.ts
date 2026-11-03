import { Injectable } from '@nestjs/common';
import { StorageService } from '../../platform/storage/storage.service';

export interface TranscriptSegmentInput {
  startMs: number;
  endMs: number;
  speaker: string | null;
  text: string;
}

export interface TranscriptionResult {
  provider: string;
  model: string;
  language: string;
  segments: TranscriptSegmentInput[];
}

/**
 * Speech-to-text for finished recordings. Only a fake exists: choosing a real provider
 * (cost, Indian languages, data residency) is a product decision still to be made.
 */
export abstract class TranscriptionProvider {
  abstract transcribe(input: {
    objectKey: string;
    sessionId: string;
  }): Promise<TranscriptionResult>;
}

/**
 * Deterministic fake. If `<objectKey>.transcript.json` exists in storage (a list of segments),
 * it returns that; otherwise a short generic transcript. Never calls an external service.
 */
@Injectable()
export class FakeTranscriptionProvider extends TranscriptionProvider {
  constructor(private readonly storage: StorageService) {
    super();
  }

  async transcribe(input: { objectKey: string; sessionId: string }): Promise<TranscriptionResult> {
    const sample = await this.storage.getText(`${input.objectKey}.transcript.json`);
    const segments: TranscriptSegmentInput[] = sample
      ? (JSON.parse(sample) as TranscriptSegmentInput[])
      : [
          {
            startMs: 0,
            endMs: 15_000,
            speaker: 'tutor',
            text: 'Welcome. Today we will work through your question step by step.',
          },
          {
            startMs: 15_000,
            endMs: 45_000,
            speaker: 'tutor',
            text: 'First, let us restate the problem and list what we already know.',
          },
          {
            startMs: 45_000,
            endMs: 60_000,
            speaker: 'student',
            text: 'That makes sense. Can we try one more example?',
          },
        ];
    return { provider: 'fake', model: 'fake-transcriber-v1', language: 'en', segments };
  }
}
