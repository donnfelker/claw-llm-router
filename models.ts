/**
 * Claw LLM Router — Model Definitions
 *
 * Full ModelDefinitionConfig for each tier. OpenClaw uses this metadata
 * for cost display, capability routing, and the /v1/models endpoint.
 */

export type ModelApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "github-copilot"
  | "bedrock-converse-stream";

export type ModelDefinitionConfig = {
  id: string;
  name: string;
  api?: ModelApi;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
};

export type ModelProviderConfig = {
  baseUrl: string;
  apiKey?: string;
  api?: ModelApi;
  models: ModelDefinitionConfig[];
};

export const PROXY_PORT = 8401;
export const PROVIDER_ID = "claw-llm-router";
export const BASE_URL = `http://127.0.0.1:${PROXY_PORT}/v1`;

/** Virtual model definitions exposed to OpenClaw */
export const ROUTER_MODELS: ModelDefinitionConfig[] = [
  {
    id: "auto",
    name: "Smart Router (auto)",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.075, output: 0.6, cacheRead: 0, cacheWrite: 0 }, // blended estimate
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: "simple",
    name: "Simple — Gemini 2.5 Flash",
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.075, output: 0.6, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: "medium",
    name: "Medium — Claude Haiku 4.5",
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "complex",
    name: "Complex — Claude Sonnet 4.6",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "reasoning",
    name: "Reasoning — Claude Opus 4.6",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
];

export function buildProviderConfig(): ModelProviderConfig {
  return {
    baseUrl: BASE_URL,
    apiKey: "local",
    api: "openai-completions",
    models: ROUTER_MODELS,
  };
}
