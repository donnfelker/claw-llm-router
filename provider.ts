/**
 * Claw LLM Router — Provider Plugin Definition
 *
 * Registered at runtime via api.registerProvider().
 * No auth required from OpenClaw's perspective — the proxy handles
 * routing to providers using credentials from OpenClaw's auth stores
 * (auth-profiles.json, auth.json, env vars). Never stores credentials itself.
 */

import { buildProviderConfig, PROVIDER_ID } from "./models.js";

export type ProviderPlugin = {
  id: string;
  label: string;
  docsPath?: string;
  aliases?: string[];
  envVars?: string[];
  models?: ReturnType<typeof buildProviderConfig>;
  auth: unknown[];
};

export const clawRouterProvider: ProviderPlugin = {
  id: PROVIDER_ID,
  label: "Claw LLM Router",
  docsPath: "https://github.com/donnfelker/claw-llm-router",
  aliases: ["clawrouter", "router"],
  envVars: ["ANTHROPIC_API_KEY", "GEMINI_API_KEY"],
  models: buildProviderConfig(),
  auth: [], // No auth needed — proxy handles it
};
