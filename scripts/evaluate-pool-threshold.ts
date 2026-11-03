/**
 * Evaluates the pooling similarity threshold on a small hand-labelled set of request pairs.
 *   yarn pool:evaluate            (uses the deterministic fake embedding provider)
 * Prints precision, recall and F1 for a range of thresholds and the current POOL_SIMILARITY_THRESHOLD.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cosine, FakeEmbeddingProvider } from '../src/providers/embeddings/embedding.provider';

interface Pair {
  a: string;
  b: string;
  same: boolean;
}

async function main(): Promise<void> {
  const pairs = JSON.parse(
    readFileSync(resolve(__dirname, 'fixtures/pool-threshold-pairs.json'), 'utf8'),
  ) as Pair[];
  const provider = new FakeEmbeddingProvider();
  const scored = await Promise.all(
    pairs.map(async (p) => ({
      ...p,
      sim: cosine(await provider.embed(p.a), await provider.embed(p.b)),
    })),
  );
  const current = Number(process.env.POOL_SIMILARITY_THRESHOLD ?? 0.5);
  const thresholds = [...new Set([0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, current])].sort();

  console.log(
    `Model: ${provider.model}. Pairs: ${pairs.length} (${pairs.filter((p) => p.same).length} same, ${pairs.filter((p) => !p.same).length} different)`,
  );
  console.log('threshold  precision  recall  f1     tp fp fn');
  for (const th of thresholds) {
    const tp = scored.filter((s) => s.same && s.sim >= th).length;
    const fp = scored.filter((s) => !s.same && s.sim >= th).length;
    const fn = scored.filter((s) => s.same && s.sim < th).length;
    const precision = tp + fp ? tp / (tp + fp) : 1;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    const mark = th === current ? '  <- current' : '';
    console.log(
      `${th.toFixed(2).padEnd(10)} ${precision.toFixed(2).padEnd(10)} ${recall.toFixed(2).padEnd(7)} ${f1.toFixed(2).padEnd(6)} ${String(tp).padStart(2)} ${String(fp).padStart(2)} ${String(fn).padStart(2)}${mark}`,
    );
  }
  console.log('\nLowest-scoring "same" pairs and highest-scoring "different" pairs:');
  for (const s of [...scored].sort((x, y) => x.sim - y.sim)) {
    if ((s.same && s.sim < current) || (!s.same && s.sim >= current * 0.6)) {
      console.log(`  ${s.same ? 'same' : 'diff'} ${s.sim.toFixed(2)}  "${s.a}" | "${s.b}"`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
