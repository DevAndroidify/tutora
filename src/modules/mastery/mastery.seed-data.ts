/** [prompt, options, correctIndex] per skill slug. Grade 11-12 maths plus one finance skill. */
export type SeedQuestion = [prompt: string, options: string[], correctIndex: number];

export const QUESTION_SEED: Record<string, SeedQuestion[]> = {
  calculus: [
    ['What is d/dx of x^3?', ['3x^2', 'x^2', '3x', 'x^3/3'], 0],
    ['What is the integral of 2x dx?', ['x^2 + C', '2x^2 + C', 'x + C', '2 + C'], 0],
    ['lim(x->0) sin(x)/x equals', ['0', '1', 'Infinity', 'Does not exist'], 1],
    ['d/dx of e^x is', ['x e^(x-1)', 'e^x', 'ln x', '1/x'], 1],
    ['The derivative of ln(x) is', ['x', 'e^x', '1/x', 'ln(x)/x'], 2],
    ["If f'(x) > 0 on an interval, f is", ['decreasing', 'constant', 'increasing', 'undefined'], 2],
  ],
  algebra: [
    ['The value of i^2 is', ['1', '-1', 'i', '0'], 1],
    ['How many ways can 3 people sit in a row?', ['3', '6', '9', '27'], 1],
    ['The 5th term of 2, 4, 6, ... is', ['8', '10', '12', '5'], 1],
    ['Determinant of [[1,2],[3,4]] is', ['-2', '2', '10', '-10'], 0],
    ['Number of terms in the expansion of (a+b)^6', ['6', '7', '8', '12'], 1],
  ],
  'coordinate-geometry': [
    ['Slope of the line y = 3x + 2 is', ['2', '3', '1/3', '-3'], 1],
    ['Distance between (0,0) and (3,4) is', ['5', '7', '25', '1'], 0],
    ['x^2 + y^2 = 25 is a circle of radius', ['25', '5', '10', '2.5'], 1],
    ['Lines with slopes 2 and -1/2 are', ['parallel', 'perpendicular', 'coincident', 'neither'], 1],
    ['y^2 = 4ax is a', ['circle', 'ellipse', 'parabola', 'hyperbola'], 2],
  ],
  'probability-and-statistics': [
    ['Probability of heads on a fair coin', ['0', '0.25', '0.5', '1'], 2],
    ['Mean of 2, 4, 6', ['4', '6', '12', '3'], 0],
    ['P(A) + P(not A) equals', ['0', '0.5', '1', '2'], 2],
    ['Probability of rolling a 6 on a fair die', ['1/6', '1/3', '1/2', '6'], 0],
    ['Median of 1, 3, 9', ['3', '4.33', '9', '1'], 0],
  ],
  'technical-analysis': [
    [
      'A long lower wick on a candle suggests',
      ['selling pressure won', 'buyers pushed price back up', 'no trading', 'a stock split'],
      1,
    ],
    ['RSI above 70 is commonly read as', ['oversold', 'overbought', 'neutral', 'illiquid'], 1],
    [
      'A stop-loss is used to',
      ['guarantee profit', 'limit loss', 'raise margin', 'avoid taxes'],
      1,
    ],
    [
      'Support is a price level where',
      ['demand tends to appear', 'trading halts', 'dividends are paid', 'IPO opens'],
      0,
    ],
    [
      'Risking 1% per trade on a 1,00,000 account means risking',
      ['100', '1,000', '10,000', '1'],
      1,
    ],
  ],
};
