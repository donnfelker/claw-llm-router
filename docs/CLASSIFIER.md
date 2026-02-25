# Prompt Classifier

The classifier determines which tier (SIMPLE, MEDIUM, COMPLEX, REASONING) a user prompt belongs to, so the router can pick the most cost-effective model.

## Architecture

```
User prompt
    │
    ▼
┌──────────────────┐
│  Rule-based       │
│  (15 dimensions)  │
└──────────────────┘
    │
    ▼
  Tier assigned
```

The classifier is 100% local — 15-dimension weighted scoring that runs locally with no API calls. Ambiguous prompts (near tier boundaries) default to the rule-based result rather than calling an external LLM, because the MEDIUM tier is cheap enough to be a safe default.

### Why no LLM fallback?

An earlier version used a hybrid approach: when rule-based confidence was below 0.70, it called a cheap LLM to verify. This was removed because:

1. **Net cost increase**: The LLM classifier correctly downgraded ~35% of ambiguous prompts to SIMPLE (saving ~$0.004 each), but upgraded ~25% to COMPLEX/REASONING (costing ~$0.03-0.04 each). The upgrades dominated, making the classifier a net cost of $3.50-$74/month depending on traffic.
2. **Latency**: Added 100-500ms per LLM call on ~33% of messages.
3. **ClawRouter precedent**: ClawRouter uses 100% local classification with no LLM fallback and reports 70-80% cost savings. The savings come from the non-ambiguous prompts (both approaches classify these identically).
4. **MEDIUM is a safe default**: Cheap enough to not waste money, capable enough to handle most tasks.

## Rule-Based Classifier

### 15 Scoring Dimensions

Each dimension scores the prompt on a scale (typically -1.0 to 1.0). The weighted sum determines the tier.

| #   | Dimension             | Weight | What it detects                                                                |
| --- | --------------------- | ------ | ------------------------------------------------------------------------------ |
| 1   | `tokenCount`          | 0.08   | Prompt length (<50 tokens = -1.0, >500 = 1.0)                                  |
| 2   | `codePresence`        | 0.14   | Code keywords: `function`, `class`, `import`, ` ``` `, etc.                    |
| 3   | `reasoningMarkers`    | 0.17   | `prove`, `theorem`, `step by step`, `chain of thought`, etc.                   |
| 4   | `technicalTerms`      | 0.09   | `algorithm`, `kubernetes`, `distributed`, `architecture`, etc.                 |
| 5   | `creativeMarkers`     | 0.05   | `story`, `poem`, `brainstorm`, `write a`, etc.                                 |
| 6   | `simpleIndicators`    | 0.11   | `what is`, `define`, `hello`, `capital of` → scores -1.0 (pulls toward SIMPLE) |
| 7   | `multiStepPatterns`   | 0.11   | Regex: `first.*then`, `step \d`, numbered lists                                |
| 8   | `questionComplexity`  | 0.04   | 4+ question marks in the prompt                                                |
| 9   | `imperativeVerbs`     | 0.03   | `build`, `create`, `implement`, `deploy`, etc.                                 |
| 10  | `constraintCount`     | 0.04   | `at most`, `within`, `maximum`, `budget`, etc.                                 |
| 11  | `outputFormat`        | 0.03   | `json`, `yaml`, `table`, `format as`, etc.                                     |
| 12  | `referenceComplexity` | 0.02   | `the docs`, `the api`, `attached`, `above`, etc.                               |
| 13  | `negationComplexity`  | 0.01   | `don't`, `avoid`, `without`, `except`, etc.                                    |
| 14  | `domainSpecificity`   | 0.02   | `quantum`, `fpga`, `genomics`, `zero-knowledge`, etc.                          |
| 15  | `agenticTask`         | 0.06   | `read file`, `edit`, `deploy`, `fix`, `debug`, `step 1`, etc.                  |

Weights sum to 1.0 and are aligned with [ClawRouter](https://github.com/claw-project/claw-router)'s 14-dimension scheme, scaled to accommodate our 15th dimension (`agenticTask`).

### Tier Boundaries

The weighted sum maps to a tier via fixed boundaries:

| Score range | Tier      | Band width |
| ----------- | --------- | ---------- |
| < 0.00      | SIMPLE    | —          |
| 0.00 – 0.30 | MEDIUM    | 0.30       |
| 0.30 – 0.50 | COMPLEX   | 0.20       |
| >= 0.50     | REASONING | —          |

These boundaries match [ClawRouter](https://github.com/claw-project/claw-router)'s production-proven values. The MEDIUM band is intentionally wide (0.30) so that ambiguous prompts — which tend to cluster around boundaries — land confidently within MEDIUM rather than triggering expensive misrouting. With steepness=12.0, a score at the center of MEDIUM (0.15) has distance 0.15 to the nearest boundary, yielding confidence ~0.86.

### Special Overrides

These override the score-based mapping regardless of weighted sum:

| Condition                                                                                | Forced tier | Min confidence |
| ---------------------------------------------------------------------------------------- | ----------- | -------------- |
| >100k estimated tokens                                                                   | COMPLEX     | 0.95           |
| 2+ reasoning keywords                                                                    | REASONING   | 0.85           |
| 4+ complexity signals (technical + imperative + agentic) AND (multi-step OR long prompt) | COMPLEX     | 0.85           |

### Confidence Calculation

Confidence measures how far the score is from the nearest tier boundary, using a sigmoid function:

```
confidence = sigmoid(distance_to_nearest_boundary)
sigmoid(x) = 1 / (1 + exp(-12.0 * x))
```

Higher confidence means the score is well within a tier's range. Lower confidence means it's near a boundary. Either way, the rule-based tier is used directly.

### Signals

The classifier returns human-readable signal strings that explain why it chose a tier. Examples:

- `short (3 tokens)` — prompt is very short
- `simple (what is)` — matched a simple-indicator keyword
- `code (function, class)` — matched code keywords
- `reasoning (step by step, prove)` — matched reasoning markers

These signals appear in the router logs for debugging.

## Prompt Extraction

Before classification, the proxy extracts the actual user text from potentially wrapped messages. This prevents system prompt keywords from polluting the classification.

### Three extraction cases

1. **Packed context** — OpenClaw group chats/subagents wrap history + current message:

   ```
   [Chat messages since your last reply - for context]
   user: earlier message
   assistant: earlier reply
   [Current message - respond to this]
   What is 2+2?
   ```

   The classifier only sees `What is 2+2?`.

2. **Embedded system prompt** — Some OpenClaw paths (webchat) prepend the system prompt to the user message instead of sending it as a separate system-role message. If the system prompt text is found inside the user message, it's stripped before classification.

3. **Long message without system role** — If there's no separate system message and the user message is >500 chars, the system prompt is likely embedded. The classifier takes the text after the last `\n\n` break (if it's <500 chars) as the actual user input.

These extraction steps are critical — without them, system prompt keywords like `json`, `function`, or `code` cause misclassification (e.g., "3+1" classified as MEDIUM instead of SIMPLE because the system prompt mentioned JSON formatting).

## Forced Tier Override

Users can bypass the classifier entirely by using tier-specific model IDs:

| Model ID                                   | Tier      |
| ------------------------------------------ | --------- |
| `simple` or `claw-llm-router/simple`       | SIMPLE    |
| `medium` or `claw-llm-router/medium`       | MEDIUM    |
| `complex` or `claw-llm-router/complex`     | COMPLEX   |
| `reasoning` or `claw-llm-router/reasoning` | REASONING |

## Fallback Chain

If a provider fails, the router tries the next tier up:

| Starting tier | Fallback chain            |
| ------------- | ------------------------- |
| SIMPLE        | SIMPLE → MEDIUM → COMPLEX |
| MEDIUM        | MEDIUM → COMPLEX          |
| COMPLEX       | COMPLEX → REASONING       |
| REASONING     | REASONING (no fallback)   |
