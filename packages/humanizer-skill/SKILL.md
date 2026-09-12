# Skill — The Humanizer

> Detect 30+ tells that text was written by an LLM and (optionally) rewrite
> it to sound human, while preserving meaning, structure, and code.

Tracking issue: [#6](https://github.com/jaydubya818/hermes-harness-missioncontrol/issues/6)
Part of: [#11 — 9 Hermes Workflows](https://github.com/jaydubya818/hermes-harness-missioncontrol/issues/11)

---

## When to invoke

Use this skill when:
- You're about to publish text to a public surface (newsletter, blog,
  X/LinkedIn post, customer-facing email, Slack to the team).
- Another workflow has produced LLM output that will be presented as if
  Jay wrote it (Daily Brief #2, Weekly Business Report #9, Bookmark Inbox
  summaries #7, etc.).
- You've been handed a draft and asked "does this sound like me?"

Do **not** use it for:
- Code, JSON, YAML, or any structured payload (it only touches prose).
- Internal scratch notes / debugging logs.
- Anything where the LLM-ness is the point (e.g. a meta example).

---

## API surface

```ts
import { detect, rewrite } from "@hermes-harness-with-missioncontrol/humanizer-skill";

// 1. Mechanical detection (no network, deterministic).
const report = detect(inputText);
// → { totalTells, totalMatches, score: 0..100, tells: [...] }

// 2. Optional LLM rewrite (caller provides the client).
const result = await rewrite(inputText, llmClient, {
  skipIfScoreBelow: 8,
  maxAttempts: 2,
  voice: "a sharp, technical human at a keyboard",
});
// → { output, before, after, attempts, skipped }
```

The `LLMClient` interface is intentionally minimal:

```ts
interface LLMClient {
  complete(args: { system: string; prompt: string }): Promise<string>;
}
```

Wire up Anthropic, OpenAI, or any local model in the calling app — the
skill itself ships zero LLM dependencies. The wiring happens in
`apps/worker-runtime` (see TODO in the README for the reference impl).

---

## Catalog of tells (30+)

The detector is mechanical (regex / structural counts). Every tell has:

- A stable `id` (don't rename — workflows reference them).
- A `severity`: `low` / `medium` / `high`.
- A human-readable `label` shown in reports and rewrite prompts.

Severity weights compose into a 0..100 "AI-likeness" score, normalized
against word count so long inputs aren't unfairly penalized.

**Lexical tells** include: `delve`, `moreover`, `furthermore`,
`additionally`, `in conclusion`, `in summary`, `it is important to note`,
`it is worth noting`, `navigating the X`, `in the realm of`,
`the landscape of`, `ever-evolving`, `tapestry`, `embark on a journey`,
`treasure trove`, `plethora`, `myriad`, `vast array`, `comprehensive
guide`, `deep dive`, `game changer`, `cutting-edge`, `state-of-the-art`,
`robust`, `leverage`, `utilize`, `facilitate`, `delineate`, `elucidate`,
`underscore`, `showcase`, `as an AI`, `I don't have opinions`.

**Structural tells** include: `not only ... but also`, rule-of-three
triple lists, em-dash overuse, smart quotes, ubiquitous Oxford commas,
`pros and cons` framing, `let's dive deeper`, `imagine a world`, `in
today's fast-paced world`, `the bottom line is`, `it should be noted`,
`as we can see`, `to put it simply`.

Catalog grows append-only — see `src/detect.ts`. Test
`detect.test.ts > 'ships at least 30 distinct tell categories'` enforces
the 30+ contract.

---

## Scoring

```
weight(low) = 1, weight(medium) = 2, weight(high) = 4
score = clamp(round(sum(matches * weight) / max(25, wordCount) * 100), 0, 100)
```

Empirically:
- `0..9` → looks human. Default skip floor is **8**.
- `10..24` → some tells. Rewrite recommended.
- `25..49` → very obvious LLM output.
- `50+` → reads like ChatGPT 3.5 default voice.

---

## Rewrite prompt design

The LLM call is **targeted**: the user prompt lists the *specific* tells
that fired, with verbatim match samples. This is materially better than a
generic "make this sound human" prompt because:

1. The model knows which words to remove (not just "be casual").
2. It can preserve the rest of the sentence structure.
3. Residual passes can iterate without losing context.

System prompt is fixed; user prompt is built by `buildRewritePrompt()`.
Both are exported for inspection and testing.

---

## Tests

```bash
pnpm --filter @hermes-harness-with-missioncontrol/humanizer-skill test
pnpm --filter @hermes-harness-with-missioncontrol/humanizer-skill typecheck
```

The `rewrite.test.ts` suite uses a fake `LLMClient` — no network calls
in CI.

---

## Status

| Concern | State |
|---|---|
| Detector | ✅ shipped, 30+ tells |
| Rewrite pipeline | ✅ shipped, LLM-agnostic |
| Anthropic wiring | ⏳ deferred to `apps/worker-runtime` |
| Multi-language support | ❌ English only |
| Per-domain tell packs (Slack vs blog vs email) | ❌ TODO — single default catalog |

---

## Provenance

Spec from issue [#6](https://github.com/jaydubya818/hermes-harness-missioncontrol/issues/6),
originally surfaced by morning-review on 2026-05-16 from an Apple Note
titled "If I was starting Hermes from zero, these are the 9 workflows I'd…".
