export interface SeedSkill {
  slug: string;
  name: string;
  description: string;
  learnerNotice?: string;
  topics?: Array<[slug: string, name: string]>;
}

export interface SeedCategory {
  slug: string;
  name: string;
  description: string;
  skills?: SeedSkill[];
  children?: SeedCategory[];
}

const NOT_INVESTMENT_ADVICE =
  'Sessions are for education only and are not investment advice. Tutors must not recommend specific trades or manage your money.';

/** Starter catalog. Staff can add more in the admin app; tutors can suggest skills. */
export const CATALOG_SEED: SeedCategory[] = [
  {
    slug: 'academics',
    name: 'Academics',
    description: 'School and college subjects.',
    children: [
      {
        slug: 'school-mathematics',
        name: 'School Mathematics (Class 11-12)',
        description: 'NCERT / CBSE Class 11 and 12 mathematics.',
        skills: [
          {
            slug: 'algebra',
            name: 'Algebra',
            description: 'Complex numbers, sequences, counting, matrices and linear programming.',
            topics: [
              ['complex-numbers', 'Complex Numbers and Quadratic Equations'],
              ['permutations-and-combinations', 'Permutations and Combinations'],
              ['binomial-theorem', 'Binomial Theorem'],
              ['sequences-and-series', 'Sequences and Series'],
              ['matrices', 'Matrices'],
              ['determinants', 'Determinants'],
              ['linear-programming', 'Linear Programming'],
            ],
          },
          {
            slug: 'calculus',
            name: 'Calculus',
            description: 'Limits, derivatives, integrals and differential equations.',
            topics: [
              ['limits-and-derivatives', 'Limits and Derivatives'],
              ['continuity-and-differentiability', 'Continuity and Differentiability'],
              ['applications-of-derivatives', 'Application of Derivatives'],
              ['integrals', 'Integrals'],
              ['differential-equations', 'Differential Equations'],
            ],
          },
          {
            slug: 'coordinate-geometry',
            name: 'Coordinate Geometry',
            description: 'Straight lines, conic sections and 3D geometry.',
            topics: [
              ['straight-lines', 'Straight Lines'],
              ['conic-sections', 'Conic Sections'],
              ['three-dimensional-geometry', 'Three Dimensional Geometry'],
            ],
          },
          {
            slug: 'probability-and-statistics',
            name: 'Probability and Statistics',
            description: 'Statistics, probability and Bayes theorem.',
            topics: [
              ['statistics', 'Statistics'],
              ['probability', 'Probability'],
            ],
          },
        ],
      },
    ],
  },
  {
    slug: 'finance-investing',
    name: 'Finance & Investing',
    description: 'Understand markets and manage personal money.',
    skills: [
      {
        slug: 'stock-market-basics',
        name: 'Stock Market Basics',
        description: 'How exchanges, brokers, orders and indices work.',
        learnerNotice: NOT_INVESTMENT_ADVICE,
        topics: [
          ['demat-and-trading-accounts', 'Demat and Trading Accounts'],
          ['order-types', 'Order Types'],
          ['indices', 'Nifty, Sensex and Indices'],
        ],
      },
      {
        slug: 'technical-analysis',
        name: 'Technical Analysis',
        description: 'Charts, patterns, indicators and risk management.',
        learnerNotice: NOT_INVESTMENT_ADVICE,
        topics: [
          ['candlestick-patterns', 'Candlestick Patterns'],
          ['indicators', 'Indicators (RSI, MACD, Moving Averages)'],
          ['risk-management', 'Position Sizing and Risk Management'],
        ],
      },
      {
        slug: 'fundamental-analysis',
        name: 'Fundamental Analysis',
        description: 'Reading financial statements and valuing companies.',
        learnerNotice: NOT_INVESTMENT_ADVICE,
      },
      {
        slug: 'personal-finance',
        name: 'Personal Finance',
        description: 'Budgeting, saving, insurance, mutual funds and taxes.',
        learnerNotice: NOT_INVESTMENT_ADVICE,
      },
    ],
  },
  {
    slug: 'content-creation',
    name: 'Content Creation',
    description: 'Create, edit and grow content on social platforms.',
    skills: [
      {
        slug: 'youtube-growth',
        name: 'YouTube Channel Growth',
        description: 'Niche, titles, thumbnails, analytics and audience growth.',
      },
      {
        slug: 'video-editing',
        name: 'Video Editing',
        description: 'Editing with tools like Premiere Pro, DaVinci Resolve or CapCut.',
        topics: [
          ['cuts-and-pacing', 'Cuts and Pacing'],
          ['color-grading', 'Color Grading'],
          ['audio-cleanup', 'Audio Cleanup'],
        ],
      },
      {
        slug: 'short-form-video',
        name: 'Short-form Video (Reels & Shorts)',
        description: 'Hooks, scripting and trends for short videos.',
      },
      {
        slug: 'podcasting',
        name: 'Podcasting',
        description: 'Planning, recording and publishing a podcast.',
      },
    ],
  },
  {
    slug: 'technology',
    name: 'Technology',
    description: 'Programming, data and software tools.',
    skills: [
      {
        slug: 'python-programming',
        name: 'Python Programming',
        description: 'From basics to scripting and automation.',
      },
      {
        slug: 'web-development',
        name: 'Web Development',
        description: 'HTML, CSS, JavaScript and modern frameworks.',
      },
      {
        slug: 'excel-and-data-analysis',
        name: 'Excel and Data Analysis',
        description: 'Formulas, pivot tables, charts and dashboards.',
      },
    ],
  },
  {
    slug: 'design',
    name: 'Design',
    description: 'Visual and product design.',
    skills: [
      {
        slug: 'graphic-design',
        name: 'Graphic Design',
        description: 'Layouts, typography and branding.',
      },
      { slug: 'ui-ux-design', name: 'UI/UX Design', description: 'App and web interface design.' },
    ],
  },
  {
    slug: 'languages-communication',
    name: 'Languages & Communication',
    description: 'Speak, write and present with confidence.',
    skills: [
      {
        slug: 'spoken-english',
        name: 'Spoken English',
        description: 'Fluency and conversation practice.',
      },
      {
        slug: 'public-speaking',
        name: 'Public Speaking',
        description: 'Presentations and stage confidence.',
      },
    ],
  },
];
