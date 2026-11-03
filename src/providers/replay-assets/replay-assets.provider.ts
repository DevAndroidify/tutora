import { Injectable } from '@nestjs/common';

export type AssetKind = 'NOTES' | 'FLASHCARDS';

export interface NotesContent {
  summary: string;
  keyPoints: Array<{ text: string; atMs: number }>;
}

export interface FlashcardsContent {
  cards: Array<{ front: string; back: string; atMs: number }>;
}

export interface GeneratedAsset<T> {
  provider: string;
  model: string;
  content: T;
}

export interface TranscriptForAssets {
  skillName: string;
  segments: Array<{ startMs: number; speaker: string | null; text: string }>;
}

/**
 * Turns a transcript into study notes and flashcards. Only a fake exists; a real (LLM) provider
 * needs the product owner's choice. Whatever a provider returns is treated as untrusted data:
 * it is validated, sanitized and stored as plain text, never followed as instructions.
 */
export abstract class ReplayAssetProvider {
  abstract notes(input: TranscriptForAssets): Promise<GeneratedAsset<NotesContent>>;
  abstract flashcards(input: TranscriptForAssets): Promise<GeneratedAsset<FlashcardsContent>>;
}

/** Deterministic, offline: key points are tutor sentences; flashcards pair a question with the next tutor reply. */
@Injectable()
export class FakeReplayAssetProvider extends ReplayAssetProvider {
  async notes(input: TranscriptForAssets): Promise<GeneratedAsset<NotesContent>> {
    const tutorLines = input.segments.filter((s) => s.speaker !== 'student');
    return {
      provider: 'fake',
      model: 'fake-notes-v1',
      content: {
        summary: `Session on ${input.skillName}: ${tutorLines.length} explanation(s) covered.`,
        keyPoints: tutorLines.slice(0, 10).map((s) => ({ text: s.text, atMs: s.startMs })),
      },
    };
  }

  async flashcards(input: TranscriptForAssets): Promise<GeneratedAsset<FlashcardsContent>> {
    const cards: FlashcardsContent['cards'] = [];
    input.segments.forEach((s, i) => {
      if (!s.text.trim().endsWith('?')) return;
      const answer = input.segments.slice(i + 1).find((n) => n.speaker !== s.speaker);
      if (answer) cards.push({ front: s.text, back: answer.text, atMs: s.startMs });
    });
    if (cards.length === 0 && input.segments[0]) {
      cards.push({
        front: `What was this ${input.skillName} session about?`,
        back: input.segments[0].text,
        atMs: 0,
      });
    }
    return {
      provider: 'fake',
      model: 'fake-flashcards-v1',
      content: { cards: cards.slice(0, 20) },
    };
  }
}
