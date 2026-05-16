/**
 * Humanizer — AI-writing-tell detector.
 *
 * Each detector is a pure function over the raw input. We deliberately keep
 * the detection layer mechanical (regex + structural counts) rather than
 * LLM-based so the output is deterministic, fast, and explainable.
 *
 * The LLM-based rewrite step (see ./rewrite.ts) consumes the report from
 * `detect()` and uses it to drive a targeted rewrite prompt.
 */

export type TellSeverity = "low" | "medium" | "high";

export interface Tell {
  /** Stable identifier for this tell category. */
  id: string;
  /** Short human label. */
  label: string;
  /** Severity of the smell in isolation. */
  severity: TellSeverity;
  /** Verbatim hits from the input, in document order. */
  matches: string[];
}

export interface DetectionReport {
  /** Total tells fired (regardless of match count). */
  totalTells: number;
  /** Total individual matches across all tells. */
  totalMatches: number;
  /** Composite 0-100 "AI-likeness" score. Higher = more obvious. */
  score: number;
  /** Per-tell breakdown. Only tells with matches are included. */
  tells: Tell[];
}

interface TellDef {
  id: string;
  label: string;
  severity: TellSeverity;
  /** Pattern or pure function returning verbatim match strings. */
  test: RegExp | ((text: string) => string[]);
}

const SEVERITY_WEIGHT: Record<TellSeverity, number> = {
  low: 1,
  medium: 2,
  high: 4,
};

/**
 * The catalog of tells. 30+ entries covering the most common AI-writing
 * patterns. Adding a new tell is append-only; do not reorder existing
 * entries (consumers may rely on the ids).
 */
const TELLS: TellDef[] = [
  // --- Lexical hedges & filler -------------------------------------------------
  { id: "delve",        label: "uses 'delve'",                                severity: "high",   test: /\bdelve(s|d|ing)?\b/gi },
  { id: "moreover",     label: "uses 'moreover'",                             severity: "medium", test: /\bmoreover\b/gi },
  { id: "furthermore",  label: "uses 'furthermore'",                          severity: "medium", test: /\bfurthermore\b/gi },
  { id: "additionally", label: "starts/uses 'additionally'",                  severity: "medium", test: /\badditionally,?\b/gi },
  { id: "in_conclusion", label: "uses 'in conclusion'",                       severity: "high",   test: /\bin\s+conclusion\b/gi },
  { id: "in_summary",   label: "uses 'in summary'",                           severity: "high",   test: /\bin\s+summary\b/gi },
  { id: "to_summarize", label: "uses 'to summarize'",                         severity: "medium", test: /\bto\s+summari[sz]e\b/gi },
  { id: "it_is_important", label: "'it is important to note'",                severity: "high",   test: /\bit\s+is\s+important\s+to\s+(note|understand|consider)\b/gi },
  { id: "it_is_worth",  label: "'it is worth noting'",                        severity: "high",   test: /\bit\s+is\s+worth\s+noting\b/gi },
  { id: "navigating_the", label: "'navigating the X'",                        severity: "high",   test: /\bnavigating\s+the\s+\w+/gi },
  { id: "in_the_realm", label: "'in the realm of'",                           severity: "high",   test: /\bin\s+the\s+realm\s+of\b/gi },
  { id: "in_the_world", label: "'in the world of'",                           severity: "medium", test: /\bin\s+the\s+world\s+of\b/gi },
  { id: "the_landscape", label: "'the landscape of'",                         severity: "high",   test: /\bthe\s+landscape\s+of\b/gi },
  { id: "ever_evolving", label: "'ever-evolving' / 'ever-changing'",          severity: "high",   test: /\bever[- ](evolving|changing|growing)\b/gi },
  { id: "tapestry",     label: "uses 'tapestry'",                             severity: "high",   test: /\btapestry\b/gi },
  { id: "embark",       label: "uses 'embark on a journey'",                  severity: "high",   test: /\bembark\s+on\s+(a|the|this)\s+\w+/gi },
  { id: "treasure_trove", label: "'treasure trove'",                          severity: "medium", test: /\btreasure\s+trove\b/gi },
  { id: "plethora",     label: "uses 'plethora'",                             severity: "medium", test: /\bplethora\b/gi },
  { id: "myriad",       label: "uses 'myriad'",                               severity: "low",    test: /\bmyriad\b/gi },
  { id: "vast_array",   label: "'vast array of'",                             severity: "medium", test: /\bvast\s+array\s+of\b/gi },
  { id: "comprehensive_guide", label: "'comprehensive guide'",                severity: "medium", test: /\bcomprehensive\s+guide\b/gi },
  { id: "deep_dive",    label: "'deep dive' / 'deep dive into'",              severity: "medium", test: /\bdeep[- ]div(e|ing)\b/gi },
  { id: "game_changer", label: "'game changer' / 'game-changing'",            severity: "medium", test: /\bgame[- ]chang(er|ing)\b/gi },
  { id: "cutting_edge", label: "'cutting-edge'",                              severity: "medium", test: /\bcutting[- ]edge\b/gi },
  { id: "state_of_the_art", label: "'state-of-the-art'",                      severity: "medium", test: /\bstate[- ]of[- ]the[- ]art\b/gi },
  { id: "robust",       label: "uses 'robust' (overused)",                    severity: "low",    test: /\brobust\b/gi },
  { id: "leverage",     label: "uses 'leverage' as a verb",                   severity: "medium", test: /\bleverag(e|ed|es|ing)\b/gi },
  { id: "utilize",      label: "uses 'utilize' (prefer 'use')",               severity: "medium", test: /\butili[sz](e|ed|es|ing)\b/gi },
  { id: "facilitate",   label: "uses 'facilitate' (prefer 'help' / 'enable')", severity: "low",   test: /\bfacilitat(e|ed|es|ing)\b/gi },
  { id: "delineate",    label: "uses 'delineate'",                            severity: "low",    test: /\bdelineat(e|ed|es|ing)\b/gi },
  { id: "elucidate",    label: "uses 'elucidate'",                            severity: "medium", test: /\belucidat(e|ed|es|ing)\b/gi },
  { id: "underscore",   label: "uses 'underscore' as a verb",                 severity: "medium", test: /\bunderscor(e|ed|es|ing)\b/gi },
  { id: "showcase",     label: "uses 'showcase' (overused)",                  severity: "low",    test: /\bshowcas(e|ed|es|ing)\b/gi },
  { id: "as_an_ai",     label: "'as an AI' / 'as a language model'",          severity: "high",   test: /\bas an\s+(ai|language\s+model)\b/gi },
  { id: "i_dont_have_opinions", label: "'I don't have personal opinions'",    severity: "high",   test: /\bi\s+(do\s+not|don't)\s+have\s+(personal\s+)?(opinions|feelings|beliefs)\b/gi },
  // --- Structural --------------------------------------------------------------
  {
    id: "not_only_but_also",
    label: "'not only ... but also'",
    severity: "medium",
    test: /\bnot\s+only\b[^.\n]{0,80}\bbut\s+also\b/gi,
  },
  {
    id: "rule_of_three",
    label: "rule-of-three triple lists ('X, Y, and Z')",
    severity: "low",
    test: (text) => {
      // crude detector: count comma-and patterns that look like enumerated lists
      const re = /\b\w+(?:\s+\w+){0,2},\s+\w+(?:\s+\w+){0,2},\s+and\s+\w+(?:\s+\w+){0,2}\b/g;
      return text.match(re) ?? [];
    },
  },
  {
    id: "em_dash_heavy",
    label: "em-dashes used as a stylistic crutch (3+ in input)",
    severity: "medium",
    test: (text) => {
      const hits = text.match(/—/g) ?? [];
      return hits.length >= 3 ? hits : [];
    },
  },
  {
    id: "smart_quotes",
    label: "curly/smart quotes (suggests an LLM, not a keyboard)",
    severity: "low",
    test: /[‘’“”]/g,
  },
  {
    id: "perfect_oxford_comma",
    label: "Oxford comma in every list (3+ lists)",
    severity: "low",
    test: (text) => {
      const lists = text.match(/\b\w+(?:\s+\w+){0,3},\s+\w+(?:\s+\w+){0,3},\s+and\s+\w+/g) ?? [];
      return lists.length >= 3 ? lists : [];
    },
  },
  {
    id: "balanced_pros_cons",
    label: "explicit 'pros and cons' framing",
    severity: "medium",
    test: /\bpros\s+and\s+cons\b/gi,
  },
  {
    id: "dive_deeper",
    label: "'let's dive deeper'",
    severity: "high",
    test: /\b(let's|let\s+us)\s+dive\s+deeper\b/gi,
  },
  {
    id: "imagine_a_world",
    label: "'imagine a world where'",
    severity: "high",
    test: /\bimagine\s+a\s+world\b/gi,
  },
  {
    id: "in_todays_fast_paced",
    label: "'in today's fast-paced world'",
    severity: "high",
    test: /\bin\s+today'?s\s+fast[- ]paced\b/gi,
  },
  {
    id: "the_bottom_line",
    label: "'the bottom line is'",
    severity: "medium",
    test: /\bthe\s+bottom\s+line\s+(is|is\s+that)\b/gi,
  },
  {
    id: "it_should_be_noted",
    label: "'it should be noted'",
    severity: "medium",
    test: /\bit\s+should\s+be\s+noted\b/gi,
  },
  {
    id: "as_we_can_see",
    label: "'as we can see'",
    severity: "medium",
    test: /\bas\s+we\s+can\s+see\b/gi,
  },
  {
    id: "to_put_it_simply",
    label: "'to put it simply'",
    severity: "medium",
    test: /\bto\s+put\s+it\s+simply\b/gi,
  },
];

function runTest(def: TellDef, text: string): string[] {
  if (typeof def.test === "function") return def.test(text);
  return text.match(def.test) ?? [];
}

/**
 * Run all detectors against `text`. Returns a deterministic report; the
 * order of `tells` follows the catalog order above so consumers can rely on
 * stable rendering.
 */
export function detect(text: string): DetectionReport {
  const tells: Tell[] = [];
  let totalMatches = 0;
  let weightedScore = 0;

  for (const def of TELLS) {
    const matches = runTest(def, text);
    if (matches.length === 0) continue;
    tells.push({
      id: def.id,
      label: def.label,
      severity: def.severity,
      matches,
    });
    totalMatches += matches.length;
    weightedScore += matches.length * SEVERITY_WEIGHT[def.severity];
  }

  // Normalize against approximate word count so long inputs aren't unfairly
  // penalized. Floor at 25 words to avoid divide-by-zero on tiny snippets.
  const wordCount = Math.max(25, text.split(/\s+/).filter(Boolean).length);
  const raw = (weightedScore / wordCount) * 100;
  // Clamp 0..100. Empirically, score >35 looks "very obvious", <10 looks human.
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  return {
    totalTells: tells.length,
    totalMatches,
    score,
    tells,
  };
}

/** Convenience: the catalog of every tell id we ship. Used by tests + docs. */
export function listTellIds(): readonly string[] {
  return TELLS.map((t) => t.id);
}
