/**
 * Claw LLM Router — LLM-Based Classifier
 *
 * Called when the rule-based classifier has low confidence (ambiguous prompts).
 * Makes a single, minimal LLM call to a cheap model to classify the tier.
 *
 * Uses the provider abstraction to call LLMs directly (or via gateway fallback
 * for OAuth tokens), avoiding infinite recursion when the router is set as
 * the primary model.
 */

import type { Tier } from "./classifier.js";
import type { TierModelSpec } from "./tier-config.js";
import { classifierCall } from "./providers/index.js";

type LogFn = (msg: string) => void;

const VALID_TIERS = new Set<string>(["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]);

const CLASSIFIER_PROMPT = `You are a prompt complexity classifier. Classify the user prompt below into exactly one category. Reply with ONLY the category name in uppercase, nothing else.

Categories:
- SIMPLE: factual lookups, translations, definitions, greetings, yes/no questions, simple math
- MEDIUM: code snippets, explanations, summaries, standard Q&A, moderate analysis
- COMPLEX: multi-file code, architecture design, long-form analysis, detailed technical work
- REASONING: mathematical proofs, formal logic, multi-step derivations, deep chain-of-thought

User prompt:
`;

export async function llmClassify(
  userPrompt: string,
  classifierSpec: TierModelSpec,
  log: LogFn,
): Promise<Tier> {
  // Truncate prompt to keep classifier call cheap
  const truncated = userPrompt.slice(0, 500);
  const fullPrompt = CLASSIFIER_PROMPT + truncated;

  const responseText = await classifierCall(
    classifierSpec,
    [{ role: "user", content: fullPrompt }],
    10,
    { info: log, warn: log, error: log },
  );

  const result = responseText.toUpperCase().trim();
  if (VALID_TIERS.has(result)) {
    return result as Tier;
  }

  // Try to extract a valid tier from the response (LLM might add explanation)
  for (const tier of VALID_TIERS) {
    if (result.includes(tier)) {
      log(`LLM classifier returned "${responseText}", extracted tier: ${tier}`);
      return tier as Tier;
    }
  }

  log(`LLM classifier returned invalid response: "${responseText}", falling back to MEDIUM`);
  return "MEDIUM";
}
