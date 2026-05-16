import type { DetectionReport, Tell } from "./detect.js";
import { detect } from "./detect.js";

/**
 * Humanizer — LLM-driven rewrite pipeline.
 *
 * The detector (./detect.ts) is mechanical and deterministic. The rewrite
 * step is the part that needs an LLM: it consumes the detection report,
 * builds a tightly-scoped prompt that names the *specific* tells, and asks
 * the model to rewrite while preserving meaning, structure, and code.
 *
 * This module is dependency-injected — callers pass in a `LLMClient`. That
 * keeps this package free of any direct Anthropic/OpenAI SDK dependency and
 * makes the unit tests fully hermetic.
 */

export interface LLMClient {
  /** Single-shot completion. Returns the model's text output. */
  complete(args: { system: string; prompt: string }): Promise<string>;
}

export interface RewriteOptions {
  /**
   * Stop early if the input already looks human enough. The score is the
   * composite 0..100 score from `detect()`. Default 8.
   */
  skipIfScoreBelow?: number;
  /**
   * Max attempts. If after a rewrite the score is still high, we re-prompt
   * with the residual report. Default 2.
   */
  maxAttempts?: number;
  /**
   * The voice we aim for. Defaults to a neutral "smart human at a
   * keyboard" voice. Override per workflow (e.g. "casual Slack", "blog").
   */
  voice?: string;
}

export interface RewriteResult {
  /** The final (possibly multi-pass) rewritten text. */
  output: string;
  /** Before/after detection reports — caller can show delta in UI/logs. */
  before: DetectionReport;
  after: DetectionReport;
  /** How many rewrite passes actually ran. */
  attempts: number;
  /** True if we returned early without calling the LLM (score below floor). */
  skipped: boolean;
}

const DEFAULT_VOICE =
  "a sharp, technical human at a keyboard — concrete nouns, short sentences, no hedging, no corporate filler";

const SYSTEM_PROMPT = `You are a copy editor whose only job is to remove the
"smell" of LLM-generated prose while preserving:
  (1) the author's intent, claims, and structure,
  (2) any code blocks, URLs, file paths, identifiers verbatim,
  (3) numbered lists and headings as-is.

You may not add new information, soften factual claims, or change the
meaning of any sentence. Your only job is to make it sound like a human
wrote it.`;

/** Build the per-call user prompt from the residual detection report. */
export function buildRewritePrompt(input: string, report: DetectionReport, voice: string): string {
  const tellList =
    report.tells.length === 0
      ? "(none — but the user has asked for a stylistic pass; still aim for the target voice)"
      : report.tells.map((t) => `  - ${t.label} — matches: ${formatMatches(t)}`).join("\n");

  return [
    `Target voice: ${voice}`,
    "",
    `The text below has been flagged for the following AI-writing tells. Rewrite the text so that NONE of these tells remain, while preserving meaning and any code/URLs verbatim.`,
    "",
    "Flagged tells:",
    tellList,
    "",
    "Constraints:",
    "  - Do not add new claims or examples.",
    "  - Do not change numbers, names, or quoted strings.",
    "  - Keep paragraph and list structure unless removing a tell requires breaking a sentence.",
    "  - Output only the rewritten text. No preamble. No explanation.",
    "",
    "---TEXT TO REWRITE---",
    input,
    "---END TEXT---",
  ].join("\n");
}

function formatMatches(tell: Tell): string {
  // Cap match list so the prompt does not balloon on input with hundreds of
  // hits. The detector still reports the full count to the caller.
  const sample = tell.matches.slice(0, 5).map((m) => JSON.stringify(m)).join(", ");
  return tell.matches.length > 5 ? `${sample}, ... (${tell.matches.length} total)` : sample;
}

/**
 * Rewrite `input` to remove AI-writing tells, using `client` for LLM calls.
 *
 * The function is intentionally synchronous in its detection phase and
 * async only when the LLM is actually required. That makes the "no rewrite
 * needed" path zero-network.
 */
export async function rewrite(
  input: string,
  client: LLMClient,
  options: RewriteOptions = {}
): Promise<RewriteResult> {
  const skipFloor = options.skipIfScoreBelow ?? 8;
  const maxAttempts = options.maxAttempts ?? 2;
  const voice = options.voice ?? DEFAULT_VOICE;

  const before = detect(input);

  if (before.score < skipFloor) {
    return {
      output: input,
      before,
      after: before,
      attempts: 0,
      skipped: true,
    };
  }

  let current = input;
  let attempts = 0;
  let after = before;

  while (attempts < maxAttempts) {
    attempts += 1;
    const prompt = buildRewritePrompt(current, after, voice);
    const next = await client.complete({ system: SYSTEM_PROMPT, prompt });
    current = next.trim();
    after = detect(current);
    if (after.score < skipFloor) break;
  }

  return {
    output: current,
    before,
    after,
    attempts,
    skipped: false,
  };
}
