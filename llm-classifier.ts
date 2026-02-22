/**
 * Claw LLM Router — LLM-Based Classifier
 *
 * Called when the rule-based classifier has low confidence (ambiguous prompts).
 * Makes a single, minimal LLM call to a cheap model to classify the tier.
 *
 * IMPORTANT: Makes DIRECT HTTP calls to the provider — does NOT go through the
 * router proxy. This prevents infinite recursion (router → classifier → router).
 */

import type { Tier } from "./classifier.js";
import type { TierModelSpec } from "./tier-config.js";

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

const ANTHROPIC_VERSION = "2023-06-01";

function anthropicHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (apiKey.startsWith("sk-ant-oat")) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  } else {
    headers["x-api-key"] = apiKey;
  }
  return headers;
}

async function callAnthropic(spec: TierModelSpec, prompt: string): Promise<string> {
  const url = `${spec.baseUrl}/messages`;
  const resp = await fetch(url, {
    method: "POST",
    headers: anthropicHeaders(spec.apiKey),
    body: JSON.stringify({
      model: spec.modelId,
      max_tokens: 10,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic classifier ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json() as { content?: Array<{ text?: string }> };
  return data.content?.[0]?.text?.trim() ?? "";
}

async function callOpenAICompatible(spec: TierModelSpec, prompt: string): Promise<string> {
  const url = `${spec.baseUrl}/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${spec.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: spec.modelId,
      max_tokens: 10,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`${spec.provider} classifier ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

export async function llmClassify(
  userPrompt: string,
  classifierSpec: TierModelSpec,
  log: LogFn,
): Promise<Tier> {
  // Truncate prompt to keep classifier call cheap
  const truncated = userPrompt.slice(0, 500);
  const fullPrompt = CLASSIFIER_PROMPT + truncated;

  let responseText: string;
  if (classifierSpec.isAnthropic) {
    responseText = await callAnthropic(classifierSpec, fullPrompt);
  } else {
    responseText = await callOpenAICompatible(classifierSpec, fullPrompt);
  }

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
