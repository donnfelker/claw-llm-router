/**
 * Claw LLM Router — LLM-Based Classifier
 *
 * Called when the rule-based classifier has low confidence (ambiguous prompts).
 * Makes a single, minimal LLM call to a cheap model to classify the tier.
 *
 * Routes through the OpenClaw gateway (NOT through the router proxy) to avoid
 * infinite recursion and to leverage the gateway's provider auth handling.
 */

import { readFileSync } from "node:fs";
import type { Tier } from "./classifier.js";
import type { TierModelSpec } from "./tier-config.js";

type LogFn = (msg: string) => void;

const HOME = process.env.HOME;
if (!HOME) throw new Error("[claw-llm-router] HOME environment variable not set");
const OPENCLAW_CONFIG_PATH = `${HOME}/.openclaw/openclaw.json`;

const VALID_TIERS = new Set<string>(["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]);

const CLASSIFIER_PROMPT = `You are a prompt complexity classifier. Classify the user prompt below into exactly one category. Reply with ONLY the category name in uppercase, nothing else.

Categories:
- SIMPLE: factual lookups, translations, definitions, greetings, yes/no questions, simple math
- MEDIUM: code snippets, explanations, summaries, standard Q&A, moderate analysis
- COMPLEX: multi-file code, architecture design, long-form analysis, detailed technical work
- REASONING: mathematical proofs, formal logic, multi-step derivations, deep chain-of-thought

User prompt:
`;

function getGatewayInfo(): { port: number; token: string } {
  const raw = readFileSync(OPENCLAW_CONFIG_PATH, "utf8");
  const config = JSON.parse(raw) as { gateway?: { port?: number; auth?: { token?: string } } };
  return {
    port: config.gateway?.port ?? 18789,
    token: config.gateway?.auth?.token ?? "",
  };
}

export async function llmClassify(
  userPrompt: string,
  classifierSpec: TierModelSpec,
  log: LogFn,
): Promise<Tier> {
  // Truncate prompt to keep classifier call cheap
  const truncated = userPrompt.slice(0, 500);
  const fullPrompt = CLASSIFIER_PROMPT + truncated;
  const modelId = `${classifierSpec.provider}/${classifierSpec.modelId}`;

  // Route through OpenClaw gateway (NOT the router proxy) to:
  // 1. Avoid infinite recursion
  // 2. Leverage the gateway's provider auth handling
  const gw = getGatewayInfo();
  const url = `http://127.0.0.1:${gw.port}/v1/chat/completions`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${gw.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 10,
      temperature: 0,
      messages: [{ role: "user", content: fullPrompt }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM classifier ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  const responseText = data.choices?.[0]?.message?.content?.trim() ?? "";

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
