import { Injectable } from '@nestjs/common';

export const EMBEDDING_DIMENSIONS = 1024;

/**
 * Text embeddings for pooling similar requests. Only a deterministic fake exists; choosing a real
 * model (multilingual support for Hinglish, cost, hosting) is a product decision.
 */
export abstract class EmbeddingProvider {
  abstract readonly model: string;
  abstract embed(text: string): Promise<number[]>;
}

const STOPWORDS = new Set(
  'a an the and or but if of to in on for with at by from is are was were be been am i me my we our you your it this that these those how what why when can could should would do does did please help want need learn understand about'.split(
    ' ',
  ),
);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)); // crude singular
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Feature hashing of words and word pairs into 1024 dimensions, L2-normalised.
 * Same input -> same vector; overlapping vocabulary -> high cosine similarity.
 */
@Injectable()
export class FakeEmbeddingProvider extends EmbeddingProvider {
  readonly model = 'fake-hashing-v1';

  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    const words = tokens(text);
    const features = [...words, ...words.slice(1).map((w, i) => `${words[i]}_${w}`)];
    for (const f of features) {
      const h = fnv1a(f);
      v[h % EMBEDDING_DIMENSIONS]! += h & 1 ? 1 : -1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // inputs are normalised
}
