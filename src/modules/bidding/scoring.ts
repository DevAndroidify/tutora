/**
 * Default bid ranking: 0.40·M + 0.25·S + 0.20·R + 0.15·P, each input in [0, 1].
 *
 *   M  outcome/mastery score for this skill. Neutral 0.5 until Part 13 provides real data.
 *   S  schedule fit: earliest proposed start among the bids = 1, latest = 0.
 *   R  reliability (attendance, no-shows). Neutral 0.5 until Parts 11-12 provide data.
 *   P  price: cheapest bid = 1, most expensive = 0.
 *
 * With a single bid, relative inputs are 1.
 */
export const WEIGHTS = { M: 0.4, S: 0.25, R: 0.2, P: 0.15 } as const;
export const NEUTRAL = 0.5;

export interface ScoreInput {
  id: string;
  seatPricePaise: number;
  proposedStartAt: Date;
  mastery?: number | null;
  reliability?: number | null;
}

export interface ScoreComponent {
  key: keyof typeof WEIGHTS;
  label: string;
  weight: number;
  value: number;
  placeholder: boolean;
  note: string;
}

export interface BidScore {
  total: number;
  components: ScoreComponent[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Lower is better -> 1 for the min, 0 for the max. */
function relative(value: number, min: number, max: number): number {
  return max === min ? 1 : (max - value) / (max - min);
}

export function scoreBids(inputs: ScoreInput[]): Map<string, BidScore> {
  const prices = inputs.map((b) => b.seatPricePaise);
  const starts = inputs.map((b) => b.proposedStartAt.getTime());
  const [pMin, pMax] = [Math.min(...prices), Math.max(...prices)];
  const [sMin, sMax] = [Math.min(...starts), Math.max(...starts)];

  const out = new Map<string, BidScore>();
  for (const b of inputs) {
    const components: ScoreComponent[] = [
      {
        key: 'M',
        label: 'Teaching outcomes',
        weight: WEIGHTS.M,
        value: b.mastery ?? NEUTRAL,
        placeholder: b.mastery == null,
        note:
          b.mastery == null ? 'Not enough data yet; neutral value used.' : 'From learner outcomes.',
      },
      {
        key: 'S',
        label: 'Schedule fit',
        weight: WEIGHTS.S,
        value: relative(b.proposedStartAt.getTime(), sMin, sMax),
        placeholder: false,
        note: 'Earlier proposed start scores higher.',
      },
      {
        key: 'R',
        label: 'Reliability',
        weight: WEIGHTS.R,
        value: b.reliability ?? NEUTRAL,
        placeholder: b.reliability == null,
        note:
          b.reliability == null
            ? 'Not enough data yet; neutral value used.'
            : 'From attendance history.',
      },
      {
        key: 'P',
        label: 'Price',
        weight: WEIGHTS.P,
        value: relative(b.seatPricePaise, pMin, pMax),
        placeholder: false,
        note: 'Lower price scores higher.',
      },
    ].map((c) => ({ ...c, value: round(c.value) })) as ScoreComponent[];
    out.set(b.id, {
      total: round(components.reduce((sum, c) => sum + c.weight * c.value, 0)),
      components,
    });
  }
  return out;
}
