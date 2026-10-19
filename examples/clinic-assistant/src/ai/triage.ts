/**
 * Rule-based urgency screening. Deterministic and auditable on purpose: it never diagnoses,
 * it only decides how soon the person should get care and where, using published red flags.
 * The model may phrase the answer, but the urgency level always comes from these rules.
 */

export type Urgency = 'emergency' | 'urgent' | 'soon' | 'routine';

export interface ScreeningResult {
  readonly urgency: Urgency;
  readonly headline: string;
  readonly guidance: readonly string[];
  /** Red flags found in the description (symptom words, never conditions). */
  readonly redFlags: readonly string[];
  /** Number to call now, when the level calls for it. */
  readonly callNumber?: '911' | '988';
  readonly disclaimer: string;
}

interface Rule {
  readonly flag: string;
  readonly level: Urgency;
  readonly patterns: readonly RegExp[];
  /** Calls for the crisis line in addition to 911. */
  readonly crisis?: boolean;
}

const RULES: readonly Rule[] = [
  { flag: 'chest pain or pressure', level: 'emergency', patterns: [/chest (pain|pressure|tightness|is tight|hurts)/, /pain (in|across) (my |the )?chest/, /crushing (pain|feeling)/, /pain (spreading|going|moving) (to|into|down) (my |the )?(left )?(arm|jaw)/] },
  {
    flag: 'difficulty breathing',
    level: 'emergency',
    patterns: [/(can'?t|cannot|can not|hard to|trouble|difficulty|struggling to|unable to) (breathe|breath|breathing|catch my breath)/, /short(ness)? of breath/, /breathless/, /gasping/, /(lips|face) (are |is |turning )?blue/, /choking/],
  },
  {
    flag: 'possible stroke signs (face, arm or speech)',
    level: 'emergency',
    patterns: [/face (is )?(droop|drooping|numb)/, /droop(ing|y)? (face|mouth|smile)/, /slurred (speech|words)/, /(can'?t|cannot|trouble) (speak|talk|find (my )?words)/, /(arm|leg|side of (my )?body) (is |went |feels )?(weak|numb|limp)/, /one side .{0,20}(weak|numb)/, /sudden (confusion|vision loss|loss of vision|worst headache)/, /\bstroke\b/],
  },
  {
    flag: 'severe bleeding',
    level: 'emergency',
    patterns: [/(severe|heavy|uncontrolled|a lot of|lots of) bleeding/, /bleeding (heavily|badly|a lot|won'?t stop|that won'?t stop|will not stop)/, /won'?t stop bleeding/, /(vomiting|throwing up|coughing up) blood/, /blood (is )?(gushing|spurting)/],
  },
  {
    flag: 'thoughts of suicide or self-harm',
    level: 'emergency',
    crisis: true,
    patterns: [/suicid/, /kill (myself|me)/, /end (my|it all|my own) ?life|end it all/, /take my (own )?life/, /(don'?t|do not) want to (live|be alive|be here)/, /self[- ]?harm/, /hurt(ing)? myself/],
  },
  { flag: 'signs of a severe allergic reaction', level: 'emergency', patterns: [/throat (is )?(swelling|closing|tight)/, /swollen (tongue|lips|throat)/, /anaphyla/] },
  { flag: 'fainting or unresponsive', level: 'emergency', patterns: [/(passed|passing) out/, /unconscious/, /unresponsive/, /fainted/, /seizure/] },
  { flag: 'high fever', level: 'urgent', patterns: [/high fever/, /fever (of|over|above) (39|40|41|10[2-5])/, /\b(39|40|41)(\.\d)? ?(°|degrees)/] },
  { flag: 'fever in a baby', level: 'urgent', patterns: [/(baby|infant|newborn).{0,40}(fever|temperature)/, /(fever|temperature).{0,40}(baby|infant|newborn)/] },
  { flag: 'severe pain', level: 'urgent', patterns: [/(severe|unbearable|worst|excruciating) (pain|headache|stomach|abdominal)/] },
  { flag: 'unable to keep fluids down', level: 'urgent', patterns: [/(can'?t|cannot) keep (anything|fluids|water) down/, /vomiting (all day|for (two|2|three|3) days|non-?stop)/] },
  { flag: 'possible broken bone or deep cut', level: 'urgent', patterns: [/(broken|fractured) (bone|arm|leg|wrist|ankle|finger)/, /deep cut/, /needs? stitches/] },
  { flag: 'fever', level: 'soon', patterns: [/\bfever/, /temperature/] },
  { flag: 'cough lasting a while', level: 'soon', patterns: [/cough/] },
  { flag: 'rash or skin change', level: 'soon', patterns: [/rash/, /mole/, /itch/, /skin/] },
  { flag: 'ear, throat or urinary discomfort', level: 'soon', patterns: [/ear ?ache|ear pain|sore throat|burning (when|while) (i )?(pee|urinat)/] },
  { flag: 'pain', level: 'soon', patterns: [/\bpain\b|\bhurts?\b|\bache/] },
];

const NEGATION = /\b(no|not|without|never|denies?|don'?t have|haven'?t had|isn'?t|wasn'?t)\s+(\w+\s+){0,2}$/;
const ORDER: Record<Urgency, number> = { routine: 0, soon: 1, urgent: 2, emergency: 3 };

export const SCREENING_DISCLAIMER = 'This is a safety screen, not a diagnosis. Only a clinician who examines you can tell you what is causing your symptoms.';

function matches(text: string, rule: Rule): boolean {
  for (const re of rule.patterns) {
    const global = new RegExp(re.source, 'g');
    for (const m of text.matchAll(global)) {
      const before = text.slice(Math.max(0, m.index - 30), m.index);
      if (!NEGATION.test(before)) return true;
    }
  }
  return false;
}

/** Screens a free-text description of symptoms. */
export function screenSymptoms(description: string): ScreeningResult {
  const text = description.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ');
  const hits = RULES.filter((r) => matches(text, r));
  const level = hits.reduce<Urgency>((acc, r) => (ORDER[r.level] > ORDER[acc] ? r.level : acc), 'routine');
  const flags = hits.filter((r) => r.level === level).map((r) => r.flag);
  const crisis = hits.some((r) => r.crisis);

  if (level === 'emergency') {
    const guidance = crisis
      ? [
          'If you might act on these thoughts or are in danger right now, call 911 or go to the nearest emergency department.',
          'You can call or text 9-8-8 at any time to talk with a trained crisis responder.',
          'If you can, stay with someone you trust while you get help.',
        ]
      : [
          'Call 911 now, or have someone take you to the nearest emergency department.',
          'Do not drive yourself and do not wait for a clinic appointment.',
          'If symptoms ease, still get checked today: these signs need a same-day emergency assessment.',
        ];
    return {
      urgency: 'emergency',
      headline: crisis ? 'Please reach out for help right now' : 'This needs emergency care now',
      guidance,
      redFlags: flags,
      callNumber: crisis ? '988' : '911',
      disclaimer: SCREENING_DISCLAIMER,
    };
  }
  if (level === 'urgent') {
    return {
      urgency: 'urgent',
      headline: 'Get seen today',
      guidance: [
        'Book a same-day urgent visit (held back every weekday morning) or call the front desk at 416-555-0142.',
        'If the clinic is closed, go to an urgent care centre.',
        'Call 911 if you develop chest pain, trouble breathing, confusion or you feel much worse.',
      ],
      redFlags: flags,
      disclaimer: SCREENING_DISCLAIMER,
    };
  }
  if (level === 'soon') {
    return {
      urgency: 'soon',
      headline: 'Book a visit in the next few days',
      guidance: [
        'A regular appointment in the next 2 to 3 days is appropriate. I can show open times.',
        'Get help sooner if it gets worse, you develop a high fever, or new symptoms appear.',
      ],
      redFlags: flags,
      disclaimer: SCREENING_DISCLAIMER,
    };
  }
  return {
    urgency: 'routine',
    headline: 'A routine appointment is fine',
    guidance: ['Nothing you described needs urgent care. I can book a routine visit with your clinician.', 'If anything changes or worsens, tell me or call the clinic.'],
    redFlags: [],
    disclaimer: SCREENING_DISCLAIMER,
  };
}
