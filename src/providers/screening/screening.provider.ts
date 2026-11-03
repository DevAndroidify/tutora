/**
 * Automated text screening. The default is rule-based; a real classifier can replace it
 * later behind the same interface (never chosen without the product owner's approval).
 */

export type ScreeningRule =
  | 'CONTACT_PHONE'
  | 'CONTACT_EMAIL'
  | 'CONTACT_UPI'
  | 'CONTACT_SOCIAL'
  | 'OFF_PLATFORM_PAYMENT'
  | 'ABUSIVE_LANGUAGE'
  | 'FINANCIAL_TIP';

export type ScreeningSeverity = 'LOW' | 'MEDIUM' | 'HIGH';
/** MASK: hide the match and keep the text. FLAG: keep text, record for review. BLOCK: refuse the text. */
export type ScreeningAction = 'MASK' | 'FLAG' | 'BLOCK';

export interface ScreeningHit {
  rule: ScreeningRule;
  severity: ScreeningSeverity;
  action: ScreeningAction;
  /** The matched text, already masked where it is contact data. Max 120 chars. */
  excerpt: string;
}

export interface ScreeningResult {
  /** Text safe to store and show: contact details replaced with "[hidden]". */
  text: string;
  blocked: boolean;
  hits: ScreeningHit[];
}

export abstract class ScreeningProvider {
  abstract screen(text: string): ScreeningResult;
}

export const MASK = '[hidden]';

interface Rule {
  rule: ScreeningRule;
  severity: ScreeningSeverity;
  action: ScreeningAction;
  pattern: RegExp;
}

const ABUSIVE_WORDS = [
  'fuck',
  'fucking',
  'bitch',
  'bastard',
  'asshole',
  'slut',
  'whore',
  'chutiya',
  'madarchod',
  'behenchod',
  'bhenchod',
  'randi',
  'harami',
  'gandu',
];

/** Order matters: email before UPI so `a@b.com` is an email, not a UPI ID. */
const RULES: Rule[] = [
  {
    rule: 'CONTACT_EMAIL',
    severity: 'LOW',
    action: 'MASK',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  },
  {
    rule: 'CONTACT_UPI',
    severity: 'MEDIUM',
    action: 'MASK',
    pattern: /\b[A-Za-z0-9][A-Za-z0-9._-]{1,63}@[A-Za-z]{2,20}\b(?![.@])/g,
  },
  {
    rule: 'CONTACT_PHONE',
    severity: 'LOW',
    action: 'MASK',
    // Indian mobiles (with optional +91/0) and other international numbers written with a +.
    pattern:
      /(?:(?:\+|00)91[\s-]?|\b0)?\b[6-9]\d(?:[\s-]?\d){8}\b|\+\d{1,3}[\s-]?\d(?:[\s-]?\d){6,12}/g,
  },
  {
    rule: 'CONTACT_SOCIAL',
    severity: 'MEDIUM',
    action: 'MASK',
    pattern:
      /\b(?:wa\.me|t\.me|telegram\.me|instagram\.com|facebook\.com|fb\.me|snapchat\.com)\/[^\s]+|\b(?:whats\s?app|telegram|insta(?:gram)?|snap(?:chat)?|dm)\s+me\b|\b(?:whats\s?app|telegram|insta(?:gram)?|snap(?:chat)?)\s*(?:id|no\.?|number|handle)?\s*[:-]?\s*@?[A-Za-z0-9._]{3,}/gi,
  },
  {
    rule: 'OFF_PLATFORM_PAYMENT',
    severity: 'MEDIUM',
    action: 'FLAG',
    pattern:
      /\b(?:pay(?:\s+me)?\s+(?:directly|outside|offline|in\s+cash)|(?:g\s?pay|phone\s?pe|paytm)\s+me|send\s+(?:the\s+)?(?:money|payment|fees?)\s+(?:directly|to\s+my)|outside\s+(?:the\s+)?(?:app|platform|tutora)|(?:cheaper|discount)\s+(?:if\s+you\s+)?(?:pay|book)\s+(?:directly|outside|offline))\b/gi,
  },
  {
    rule: 'FINANCIAL_TIP',
    severity: 'MEDIUM',
    action: 'FLAG',
    pattern:
      /\b(?:guaranteed\s+(?:returns?|profits?|income)|sure[\s-]?shot|100\s?%\s+(?:profit|returns?|accuracy)|double\s+your\s+money|multi[\s-]?bagger\s+(?:tips?|calls?)|jackpot\s+(?:calls?|tips?)|(?:intraday|stock|option)\s+tips?\s+(?:daily|guaranteed|paid)|(?:buy|sell)\s+[A-Z][A-Z&]{1,14}\s+(?:at|@|above|below)\s*\d+[^.]{0,40}\btargets?\b)/gi,
  },
  {
    rule: 'ABUSIVE_LANGUAGE',
    severity: 'HIGH',
    action: 'BLOCK',
    pattern: new RegExp(`\\b(?:${ABUSIVE_WORDS.join('|')})\\b`, 'gi'),
  },
];

/** Default rule-based screening. Fast, deterministic and explainable. */
export class RuleBasedScreeningProvider extends ScreeningProvider {
  screen(input: string): ScreeningResult {
    let text = input;
    const hits: ScreeningHit[] = [];

    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      const matches = text.match(rule.pattern);
      if (!matches) continue;
      for (const m of matches) {
        hits.push({
          rule: rule.rule,
          severity: rule.severity,
          action: rule.action,
          excerpt: rule.action === 'MASK' ? MASK : m.slice(0, 120),
        });
      }
      if (rule.action === 'MASK') {
        rule.pattern.lastIndex = 0;
        text = text.replace(rule.pattern, MASK);
      }
    }
    return { text, blocked: hits.some((h) => h.action === 'BLOCK'), hits };
  }
}
