/**
 * Claw LLM Router — Tier Configuration
 *
 * Reads/writes tier-to-model mappings from a local config file (router-config.json).
 * Resolves provider baseUrl and apiKey for any OpenClaw provider.
 * Auth is NEVER stored in the plugin — always read from OpenClaw's auth stores.
 *
 * Config is stored in the plugin directory (not in openclaw.json) because
 * OpenClaw validates plugins.entries schema and rejects unknown keys.
 */

import { readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tier } from "./classifier.js";

const HOME = process.env.HOME;
if (!HOME) throw new Error("[claw-llm-router] HOME environment variable not set");

const OPENCLAW_CONFIG_PATH = `${HOME}/.openclaw/openclaw.json`;
const AUTH_PROFILES_PATH = `${HOME}/.openclaw/agents/main/agent/auth-profiles.json`;
const AUTH_JSON_PATH = `${HOME}/.openclaw/agents/main/agent/auth.json`;

// Router config stored in plugin directory to avoid openclaw.json schema conflicts
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const ROUTER_CONFIG_PATH = `${PLUGIN_DIR}/router-config.json`;

// ── Types ────────────────────────────────────────────────────────────────────

export type TierModelSpec = {
  provider: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  isAnthropic: boolean;
};

export type TierConfig = Record<Tier, TierModelSpec>;

type RouterConfig = {
  tiers: Record<Tier, string>;
  classifierModel?: string;
};

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_TIERS: Record<Tier, string> = {
  SIMPLE: "google/gemini-2.5-flash",
  MEDIUM: "anthropic/claude-haiku-4-5-20251001",
  COMPLEX: "anthropic/claude-sonnet-4-6",
  REASONING: "anthropic/claude-opus-4-6",
};

// ── Well-known provider base URLs ────────────────────────────────────────────

const WELL_KNOWN_BASE_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  perplexity: "https://api.perplexity.ai",
  xai: "https://api.x.ai/v1",
};

// Provider name → env var name mapping (when not just PROVIDER_API_KEY)
const ENV_VAR_OVERRIDES: Record<string, string> = {
  google: "GEMINI_API_KEY",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function readOpenClawConfig(): Record<string, unknown> {
  const raw = readFileSync(OPENCLAW_CONFIG_PATH, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function readRouterConfig(): RouterConfig | undefined {
  try {
    if (!existsSync(ROUTER_CONFIG_PATH)) return undefined;
    const raw = readFileSync(ROUTER_CONFIG_PATH, "utf8");
    return JSON.parse(raw) as RouterConfig;
  } catch {
    return undefined;
  }
}

function writeRouterConfigFile(config: RouterConfig): void {
  const tmp = `${ROUTER_CONFIG_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
  JSON.parse(readFileSync(tmp, "utf8")); // Validate
  renameSync(tmp, ROUTER_CONFIG_PATH);
}

function envVarName(provider: string): string {
  return ENV_VAR_OVERRIDES[provider] ?? `${provider.toUpperCase()}_API_KEY`;
}

// ── API Key Loading ──────────────────────────────────────────────────────────
// Priority: env var → auth-profiles.json → auth.json → openclaw.json env.vars
// NEVER stores keys — always reads from existing OpenClaw auth stores.
// NEVER logs keys or any portion of them.

type LogFn = ((msg: string) => void) | undefined;

export function loadApiKey(provider: string, log?: LogFn): string {
  const envKey = envVarName(provider);

  // 1. Environment variable
  if (process.env[envKey]) {
    log?.(`[auth] ${provider}: using key from env var ${envKey}`);
    return process.env[envKey]!;
  }

  // 2. auth-profiles.json (canonical credential store)
  try {
    const raw = readFileSync(AUTH_PROFILES_PATH, "utf8");
    const store = JSON.parse(raw) as { profiles?: Record<string, { token?: string; key?: string }> };
    const profile = store.profiles?.[`${provider}:default`];
    const key = profile?.token ?? profile?.key;
    if (key && key !== "proxy-handles-auth") {
      log?.(`[auth] ${provider}: using key from auth-profiles.json`);
      return key;
    }
  } catch { /* fall through */ }

  // 3. auth.json (runtime cache)
  try {
    const raw = readFileSync(AUTH_JSON_PATH, "utf8");
    const store = JSON.parse(raw) as Record<string, { key?: string; token?: string }>;
    const entry = store[provider];
    const key = entry?.key ?? entry?.token;
    if (key && key !== "proxy-handles-auth") {
      log?.(`[auth] ${provider}: using key from auth.json`);
      return key;
    }
  } catch { /* fall through */ }

  // 4. openclaw.json env.vars
  try {
    const config = readOpenClawConfig();
    const env = config.env as { vars?: Record<string, string> } | undefined;
    const val = env?.vars?.[envKey];
    if (val) {
      log?.(`[auth] ${provider}: using key from openclaw.json env.vars`);
      return val;
    }
  } catch { /* fall through */ }

  log?.(`[auth] ${provider}: NO API KEY FOUND (checked: env ${envKey}, auth-profiles.json, auth.json, openclaw.json env.vars)`);
  return "";
}

// ── Provider Resolution ──────────────────────────────────────────────────────

function resolveBaseUrl(provider: string): string {
  // First check openclaw.json models.providers for a configured baseUrl
  try {
    const config = readOpenClawConfig();
    const models = config.models as { providers?: Record<string, { baseUrl?: string }> } | undefined;
    const providerConfig = models?.providers?.[provider];
    if (providerConfig?.baseUrl) return providerConfig.baseUrl;
  } catch { /* fall through */ }

  // Fall back to well-known URLs
  const wellKnown = WELL_KNOWN_BASE_URLS[provider];
  if (wellKnown) return wellKnown;

  throw new Error(`[claw-llm-router] Unknown provider "${provider}" — not in openclaw.json and no well-known URL. Configure it in openclaw.json models.providers or use /router set.`);
}

// ── Tier Model Resolution ────────────────────────────────────────────────────

export function resolveTierModel(tierString: string, log?: LogFn): TierModelSpec {
  const slashIdx = tierString.indexOf("/");
  if (slashIdx === -1) {
    throw new Error(`[claw-llm-router] Invalid tier model format: "${tierString}" — expected "provider/model-id"`);
  }

  const provider = tierString.slice(0, slashIdx);
  const modelId = tierString.slice(slashIdx + 1);
  const baseUrl = resolveBaseUrl(provider);
  const apiKey = loadApiKey(provider, log);
  const isAnthropic = provider === "anthropic" || baseUrl.includes("anthropic.com");

  return { provider, modelId, baseUrl, apiKey, isAnthropic };
}

// ── Tier Config Read/Write ───────────────────────────────────────────────────

export function isTierConfigured(): boolean {
  const config = readRouterConfig();
  return !!config?.tiers && Object.keys(config.tiers).length === 4;
}

export function loadTierConfig(log?: LogFn): TierConfig {
  const config = readRouterConfig();
  const tiers = config?.tiers ?? DEFAULT_TIERS;

  return {
    SIMPLE: resolveTierModel(tiers.SIMPLE ?? DEFAULT_TIERS.SIMPLE, log),
    MEDIUM: resolveTierModel(tiers.MEDIUM ?? DEFAULT_TIERS.MEDIUM, log),
    COMPLEX: resolveTierModel(tiers.COMPLEX ?? DEFAULT_TIERS.COMPLEX, log),
    REASONING: resolveTierModel(tiers.REASONING ?? DEFAULT_TIERS.REASONING, log),
  };
}

export function getTierStrings(): Record<Tier, string> {
  const config = readRouterConfig();
  const tiers = config?.tiers;
  return {
    SIMPLE: tiers?.SIMPLE ?? DEFAULT_TIERS.SIMPLE,
    MEDIUM: tiers?.MEDIUM ?? DEFAULT_TIERS.MEDIUM,
    COMPLEX: tiers?.COMPLEX ?? DEFAULT_TIERS.COMPLEX,
    REASONING: tiers?.REASONING ?? DEFAULT_TIERS.REASONING,
  };
}

export function writeTierConfig(tiers: Record<Tier, string>): void {
  const existing = readRouterConfig();
  writeRouterConfigFile({
    ...existing,
    tiers,
  });
}

// ── Classifier Model ─────────────────────────────────────────────────────────

export function getClassifierModelSpec(log?: LogFn): TierModelSpec {
  const config = readRouterConfig();
  const classifierModel = config?.classifierModel;
  // Default to SIMPLE tier model (cheapest)
  const modelString = classifierModel ?? getTierStrings().SIMPLE;
  return resolveTierModel(modelString, log);
}

export function writeClassifierModel(modelString: string): void {
  const existing = readRouterConfig() ?? { tiers: DEFAULT_TIERS };
  writeRouterConfigFile({
    ...existing,
    classifierModel: modelString,
  });
}
