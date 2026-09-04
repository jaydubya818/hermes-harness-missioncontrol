/**
 * @hermes-harness-with-missioncontrol/humanizer-skill
 *
 * Detect 30+ AI-writing tells in a body of text and (optionally) rewrite
 * the text using a caller-provided LLM client.
 *
 * Quick start:
 *
 *   import { detect, rewrite } from "@hermes-harness-with-missioncontrol/humanizer-skill";
 *
 *   const report = detect(inputText);
 *   if (report.score > 15) {
 *     const result = await rewrite(inputText, anthropicClient);
 *     console.log(result.output);
 *   }
 */

export { detect, listTellIds } from "./detect.js";
export type { DetectionReport, Tell, TellSeverity } from "./detect.js";

export { rewrite, buildRewritePrompt } from "./rewrite.js";
export type { LLMClient, RewriteOptions, RewriteResult } from "./rewrite.js";
