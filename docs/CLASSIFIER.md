# Prompt Classifier

The classifier determines which tier (SIMPLE, MEDIUM, COMPLEX, REASONING) a user prompt belongs to, so the router can pick the most cost-effective model.

## Architecture

```
User prompt
    │
    ▼
┌──────────────────┐     score < 0.70 conf     ┌──────────────────┐
│  Rule-based       │ ─────────────────────────▶│  LLM classifier   │
│  (15 dimensions)  │                           │  (cheap model)    │
└──────────────────┘                           └──────────────────┘
    │ high confidence                               │
    ▼                                               ▼
  Tier assigned                                   Tier assigned
```

Two classifiers work together:

1. **Rule-based** (`classifier.ts`) — 15-dimension weighted scoring, runs locally in <1ms, no API calls
2. **LLM-based** (`llm-classifier.ts`) — called only when rule-based confidence is below 0.70, uses the cheapest configured model

## Rule-Based Classifier

### 15 Scoring Dimensions

Each dimension scores the prompt on a scale (typically -1.0 to 1.0). The weighted sum determines the tier.

| # | Dimension | Weight | What it detects |
|---|-----------|--------|-----------------|
| 1 | `tokenCount` | 0.08 | Prompt length (<50 tokens = -1.0, >500 = 1.0) |
| 2 | `codePresence` | 0.14 | Code keywords: `function`, `class`, `import`, `` ``` ``, etc. |
| 3 | `reasoningMarkers` | 0.17 | `prove`, `theorem`, `step by step`, `chain of thought`, etc. |
| 4 | `technicalTerms` | 0.09 | `algorithm`, `kubernetes`, `distributed`, `architecture`, etc. |
| 5 | `creativeMarkers` | 0.05 | `story`, `poem`, `brainstorm`, `write a`, etc. |
| 6 | `simpleIndicators` | 0.11 | `what is`, `define`, `hello`, `capital of` → scores -1.0 (pulls toward SIMPLE) |
| 7 | `multiStepPatterns` | 0.11 | Regex: `first.*then`, `step \d`, numbered lists |
| 8 | `questionComplexity` | 0.04 | 4+ question marks in the prompt |
| 9 | `imperativeVerbs` | 0.03 | `build`, `create`, `implement`, `deploy`, etc. |
| 10 | `constraintCount` | 0.04 | `at most`, `within`, `maximum`, `budget`, etc. |
| 11 | `outputFormat` | 0.03 | `json`, `yaml`, `table`, `format as`, etc. |
| 12 | `referenceComplexity` | 0.02 | `the docs`, `the api`, `attached`, `above`, etc. |
| 13 | `negationComplexity` | 0.01 | `don't`, `avoid`, `without`, `except`, etc. |
| 14 | `domainSpecificity` | 0.02 | `quantum`, `fpga`, `genomics`, `zero-knowledge`, etc. |
| 15 | `agenticTask` | 0.06 | `read file`, `edit`, `deploy`, `fix`, `debug`, `step 1`, etc. |

Weights sum to 1.0 and are aligned with [ClawRouter](https://github.com/claw-project/claw-router)'s 14-dimension scheme, scaled to accommodate our 15th dimension (`agenticTask`).

### Tier Boundaries

The weighted sum maps to a tier via fixed boundaries:

| Score range | Tier |
|-------------|------|
| < 0.00 | SIMPLE |
| 0.00 – 0.15 | MEDIUM |
| 0.15 – 0.35 | COMPLEX |
| >= 0.35 | REASONING |

### Special Overrides

These override the score-based mapping regardless of weighted sum:

| Condition | Forced tier | Min confidence |
|-----------|-------------|----------------|
| >100k estimated tokens | COMPLEX | 0.95 |
| 2+ reasoning keywords | REASONING | 0.85 |
| 4+ complexity signals (technical + imperative + agentic) AND (multi-step OR long prompt) | COMPLEX | 0.85 |

### Confidence Calculation

Confidence measures how far the score is from the nearest tier boundary, using a sigmoid function:

```
confidence = sigmoid(distance_to_nearest_boundary)
sigmoid(x) = 1 / (1 + exp(-12.0 * x))
```

- **High confidence** (>0.70): the score is well within a tier — rule-based result is used directly
- **Low confidence** (<0.70): the score is near a boundary — triggers the LLM classifier for verification

### Signals

The classifier returns human-readable signal strings that explain why it chose a tier. Examples:

- `short (3 tokens)` — prompt is very short
- `simple (what is)` — matched a simple-indicator keyword
- `code (function, class)` — matched code keywords
- `reasoning (step by step, prove)` — matched reasoning markers
- `ambiguous (conf=0.58) → needs LLM classification` — confidence too low

These signals appear in the router logs for debugging.

## LLM Classifier

When the rule-based classifier's confidence is below 0.70, the hybrid system calls a cheap LLM to verify the classification.

### How it works

1. The user prompt is truncated to 500 characters
2. A system prompt asks the LLM to respond with exactly one tier name: `SIMPLE`, `MEDIUM`, `COMPLEX`, or `REASONING`
3. The response is parsed — exact match preferred, substring extraction as fallback
4. If the LLM returns an invalid response, falls back to `MEDIUM`

### Configuration

The classifier model defaults to whatever the SIMPLE tier is set to (cheapest model). Override with:

```
/router classifier google/gemini-2.5-flash
```

### Failure modes

| Scenario | Behavior |
|----------|----------|
| No API key for classifier model | Skips LLM, falls back to MEDIUM |
| LLM call fails (timeout, error) | Falls back to MEDIUM |
| LLM returns invalid tier | Falls back to MEDIUM |
| LLM confirms rule-based result | Uses LLM result (same tier) |
| LLM overrides rule-based result | Uses LLM result (different tier) |

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

| Model ID | Tier |
|----------|------|
| `simple` or `claw-llm-router/simple` | SIMPLE |
| `medium` or `claw-llm-router/medium` | MEDIUM |
| `complex` or `claw-llm-router/complex` | COMPLEX |
| `reasoning` or `claw-llm-router/reasoning` | REASONING |

## Fallback Chain

If a provider fails, the router tries the next tier up:

| Starting tier | Fallback chain |
|---------------|----------------|
| SIMPLE | SIMPLE → MEDIUM → COMPLEX |
| MEDIUM | MEDIUM → COMPLEX |
| COMPLEX | COMPLEX → REASONING |
| REASONING | REASONING (no fallback) |
