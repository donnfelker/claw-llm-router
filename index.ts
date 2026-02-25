/**
 * Claw LLM Router — OpenClaw Plugin Entry Point
 *
 * On gateway load:
 *   1. Registers provider at runtime via api.registerProvider()
 *   2. Sets runtime config (api.config.models.providers)
 *   3. Writes provider config to openclaw.json atomically (idempotent)
 *   4. Injects auth profile placeholder
 *   5. Auto-configures default tiers on first run
 *   6. Starts in-process Node.js proxy via api.registerService()
 *   7. Registers /router slash command with subcommands
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync } from "node:fs";
import { type Server } from "node:http";
import { clawRouterProvider } from "./provider.js";
import { buildProviderConfig, PROXY_PORT, PROVIDER_ID } from "./models.js";
import { startProxy } from "./proxy.js";
import {
  isTierConfigured,
  writeTierConfig,
  getTierStrings,
  DEFAULT_TIERS,
  resolveTierModel,
  loadApiKey,
  envVarName,
} from "./tier-config.js";
import { getIsRouterPrimary } from "./providers/index.js";
import { consumeOverride } from "./providers/model-override.js";

// ── Types (duck-typed to match OpenClaw plugin API) ───────────────────────────

type PluginLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

type ModelProviderConfig = {
  baseUrl: string;
  apiKey?: string;
  api?: string;
  models: unknown[];
};

type OpenClawConfig = Record<string, unknown> & {
  models?: { providers?: Record<string, ModelProviderConfig> };
  agents?: Record<string, unknown>;
};

type BeforeModelResolveEvent = {
  prompt: string;
};

type BeforeModelResolveResult = {
  modelOverride?: string;
  providerOverride?: string;
};

type OpenClawPluginApi = {
  id: string;
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  registerProvider: (provider: unknown) => void;
  registerService: (service: {
    id: string;
    start: () => void | Promise<void>;
    stop?: () => void | Promise<void>;
  }) => void;
  registerCommand: (command: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: {
      senderId?: string;
      channel: string;
      isAuthorizedSender: boolean;
      args?: string;
      commandBody: string;
      config: Record<string, unknown>;
    }) => { text: string } | Promise<{ text: string }>;
  }) => void;
  on: (
    hookName: string,
    handler: (...args: unknown[]) => unknown,
    opts?: { priority?: number },
  ) => void;
};

// ── Config file paths ─────────────────────────────────────────────────────────

const HOME = process.env.HOME;
if (!HOME) throw new Error("[claw-llm-router] HOME environment variable not set");

const OPENCLAW_CONFIG_PATH = `${HOME}/.openclaw/openclaw.json`;
const AUTH_PROFILES_PATH = `${HOME}/.openclaw/agents/main/agent/auth-profiles.json`;

const LOG_PREFIX = "[claw-llm-router]";
const DOCS_URL = "https://github.com/donnfelker/claw-llm-router#troubleshooting";

// ── Atomic config write ───────────────────────────────────────────────────────

function atomicWriteJson(path: string, data: unknown): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  // Validate it parses back cleanly before overwriting
  JSON.parse(readFileSync(tmp, "utf8"));
  // Atomic rename (POSIX guarantee)
  renameSync(tmp, path);
}

function backupConfig(log: PluginLogger): void {
  const timestamp = Date.now();
  const backupPath = `${OPENCLAW_CONFIG_PATH}.bak.claw-llm-router.${timestamp}`;
  if (existsSync(OPENCLAW_CONFIG_PATH)) {
    copyFileSync(OPENCLAW_CONFIG_PATH, backupPath);
    log.info(`${LOG_PREFIX} Config backed up to ${backupPath}`);
  }
}

// ── injectModelsConfig ────────────────────────────────────────────────────────

function injectModelsConfig(log: PluginLogger): void {
  let config: Record<string, unknown>;
  try {
    const raw = readFileSync(OPENCLAW_CONFIG_PATH, "utf8");
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    log.warn(`${LOG_PREFIX} Could not read openclaw.json: ${err}. Skipping config injection.`);
    return;
  }

  const providerConfig = buildProviderConfig();

  // Ensure models.providers exists
  if (!config.models || typeof config.models !== "object") {
    config.models = { mode: "merge", providers: {} };
  }
  const models = config.models as { mode?: string; providers?: Record<string, unknown> };
  if (!models.providers) models.providers = {};
  if (!models.mode) models.mode = "merge";

  // Check if already up to date (idempotent)
  const existing = models.providers[PROVIDER_ID] as { baseUrl?: string } | undefined;
  if (existing?.baseUrl === providerConfig.baseUrl) {
    log.info(`${LOG_PREFIX} Config already up to date, skipping write`);
    return;
  }

  backupConfig(log);

  models.providers[PROVIDER_ID] = providerConfig;
  try {
    atomicWriteJson(OPENCLAW_CONFIG_PATH, config);
    log.info(`${LOG_PREFIX} Provider config written to openclaw.json`);
    log.info(`${LOG_PREFIX} If something goes wrong, see: ${DOCS_URL}`);
  } catch (err) {
    log.error(`${LOG_PREFIX} Failed to write openclaw.json: ${err}`);
    log.error(`${LOG_PREFIX} Troubleshooting: ${DOCS_URL}`);
  }
}

// ── injectAuthProfile ─────────────────────────────────────────────────────────

function injectAuthProfile(log: PluginLogger): void {
  let profiles: Record<string, unknown>;
  try {
    const raw = readFileSync(AUTH_PROFILES_PATH, "utf8");
    profiles = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    profiles = {};
  }

  const profileKey = `${PROVIDER_ID}:default`;
  const profileSection = profiles.profiles as Record<string, unknown> | undefined;

  if (profileSection?.[profileKey]) {
    return; // already exists
  }

  const existing = (profiles.profiles ?? {}) as Record<string, unknown>;
  const updated = {
    ...profiles,
    profiles: {
      ...existing,
      [profileKey]: {
        type: "api_key",
        provider: PROVIDER_ID,
        key: "proxy-handles-auth",
      },
    },
  };

  try {
    atomicWriteJson(AUTH_PROFILES_PATH, updated);
    log.info(`${LOG_PREFIX} Auth profile injected`);
  } catch (err) {
    log.warn(`${LOG_PREFIX} Could not inject auth profile: ${err}`);
  }
}

// ── Startup API key warnings ─────────────────────────────────────────────────

function logApiKeyWarnings(log: PluginLogger): void {
  const tiers = getTierStrings();
  const tierNames = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"] as const;
  const missing: string[] = [];

  for (const tier of tierNames) {
    const modelStr = tiers[tier];
    const slashIdx = modelStr.indexOf("/");
    if (slashIdx <= 0) continue;
    const provider = modelStr.slice(0, slashIdx);
    const { key } = loadApiKey(provider);
    if (!key) {
      missing.push(`${tier} (${modelStr}) — set ${envVarName(provider)} or run /auth`);
    }
  }

  if (missing.length > 0) {
    log.warn(`${LOG_PREFIX} ⚠ Missing API keys for ${missing.length} tier(s):`);
    for (const line of missing) {
      log.warn(`${LOG_PREFIX}   ${line}`);
    }
    log.warn(`${LOG_PREFIX}   Run /router doctor for full diagnostics`);
    log.warn(`${LOG_PREFIX}   Troubleshooting: ${DOCS_URL}`);
  }
}

// ── /router command handlers ─────────────────────────────────────────────────

const TIER_SUGGESTIONS: Record<string, string> = {
  SIMPLE: "google/gemini-2.5-flash, openai/gpt-4o-mini, groq/llama-3.3-70b-versatile (fast, cheap)",
  MEDIUM: "anthropic/claude-haiku-4-5-20251001, openai/gpt-4o-mini, xai/grok-3 (balanced)",
  COMPLEX: "anthropic/claude-sonnet-4-6, openai/gpt-4o, xai/grok-3, minimax/MiniMax-M1 (capable)",
  REASONING: "anthropic/claude-opus-4-6, openai/o1, moonshot/kimi-k2.5 (frontier reasoning)",
};

function handleHelpCommand(): { text: string } {
  const lines = [
    `Claw LLM Router — Commands`,
    ``,
    `  /router              Show status (uptime, health, current tiers)`,
    `  /router help         Show this help`,
    `  /router setup        Show current tier config + suggested models`,
    `  /router set <TIER> <provider/model>`,
    `                       Set a tier's model (SIMPLE, MEDIUM, COMPLEX, REASONING)`,
    `  /router doctor       Diagnose config, API keys, and proxy health`,
    ``,
    `Examples:`,
    `  /router set SIMPLE google/gemini-2.5-flash`,
    `  /router set REASONING anthropic/claude-opus-4-6`,
  ];
  return { text: lines.join("\n") };
}

function handleSetupCommand(): { text: string } {
  const tiers = getTierStrings();
  const lines = [
    `Claw LLM Router — Tier Configuration`,
    ``,
    `Current configuration:`,
    `  SIMPLE    → ${tiers.SIMPLE}`,
    `  MEDIUM    → ${tiers.MEDIUM}`,
    `  COMPLEX   → ${tiers.COMPLEX}`,
    `  REASONING → ${tiers.REASONING}`,
    ``,
    `To change a tier:`,
    `  /router set SIMPLE <provider/model>`,
    `  /router set MEDIUM <provider/model>`,
    `  /router set COMPLEX <provider/model>`,
    `  /router set REASONING <provider/model>`,
    ``,
    `Suggested models by tier:`,
    `  SIMPLE    → ${TIER_SUGGESTIONS.SIMPLE}`,
    `  MEDIUM    → ${TIER_SUGGESTIONS.MEDIUM}`,
    `  COMPLEX   → ${TIER_SUGGESTIONS.COMPLEX}`,
    `  REASONING → ${TIER_SUGGESTIONS.REASONING}`,
    ``,
    `Any OpenAI-compatible provider works. Anthropic uses native API with format conversion.`,
    ``,
    `Diagnose issues: /router doctor`,
  ];
  return { text: lines.join("\n") };
}

function handleSetCommand(args: string): { text: string } {
  const parts = args.split(/\s+/);
  if (parts.length !== 2) {
    return {
      text: `Usage: /router set <TIER> <provider/model>\nExample: /router set SIMPLE google/gemini-2.5-flash`,
    };
  }

  const tierName = parts[0].toUpperCase();
  const modelString = parts[1];

  const validTiers = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];
  if (!validTiers.includes(tierName)) {
    return { text: `Invalid tier "${tierName}". Must be one of: ${validTiers.join(", ")}` };
  }

  if (!modelString.includes("/")) {
    return {
      text: `Invalid model format "${modelString}". Expected "provider/model-id" (e.g., google/gemini-2.5-flash)`,
    };
  }

  // Validate the model can be resolved
  try {
    resolveTierModel(modelString);
  } catch (err) {
    return {
      text: `Could not resolve model "${modelString}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Update the tier
  const current = getTierStrings();
  current[tierName as keyof typeof current] = modelString;
  writeTierConfig(current);

  return {
    text: `Updated ${tierName} tier to: ${modelString}\n\nCurrent configuration:\n  SIMPLE    → ${current.SIMPLE}\n  MEDIUM    → ${current.MEDIUM}\n  COMPLEX   → ${current.COMPLEX}\n  REASONING → ${current.REASONING}`,
  };
}

export async function handleDoctorCommand(): Promise<{ text: string }> {
  const lines: string[] = ["Router Doctor", ""];
  let issues = 0;

  // ── Configuration ──────────────────────────────────────────────────────────
  lines.push("Configuration");

  const configOk = isTierConfigured();
  if (configOk) {
    lines.push("  ✓ Config file (router-config.json)");
  } else {
    lines.push("  ✗ Config file missing or incomplete");
    lines.push("    → Run /router setup or set tiers with /router set <TIER> <provider/model>");
    issues++;
  }

  const tiers = getTierStrings();
  const tierNames = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"] as const;
  const allPresent = tierNames.every((t) => !!tiers[t]);
  if (allPresent) {
    lines.push("  ✓ All 4 tiers configured");
  } else {
    const missing = tierNames.filter((t) => !tiers[t]);
    lines.push(`  ✗ Missing tiers: ${missing.join(", ")}`);
    issues++;
  }

  // ── Per-tier checks ────────────────────────────────────────────────────────
  lines.push("");
  lines.push("Tiers");

  for (const tier of tierNames) {
    const modelStr = tiers[tier];
    lines.push(`  ${tier} → ${modelStr}`);

    const checks: string[] = [];

    // 1. Valid format
    const slashIdx = modelStr.indexOf("/");
    if (slashIdx === -1 || slashIdx === 0 || slashIdx === modelStr.length - 1) {
      checks.push("✗ Valid format");
      issues++;
      lines.push(`    ${checks.join("  ")}`);
      lines.push(`    → Expected "provider/model-id" format`);
      continue;
    }
    checks.push("✓ Valid format");

    const provider = modelStr.slice(0, slashIdx);

    // 2. Base URL resolvable
    try {
      resolveTierModel(modelStr);
      checks.push("✓ Base URL");
    } catch {
      checks.push("✗ Base URL (unknown provider)");
      issues++;
      lines.push(`    ${checks.join("  ")}`);
      lines.push(`    → Add ${provider} to openclaw.json models.providers with a baseUrl`);
      continue;
    }

    // 3. API key available
    const { key, isOAuth } = loadApiKey(provider);
    if (key) {
      const suffix = isOAuth ? " (OAuth)" : "";
      checks.push(`✓ API key${suffix}`);
    } else {
      checks.push("✗ API key");
      issues++;
      lines.push(`    ${checks.join("  ")}`);
      lines.push(`    → Set ${envVarName(provider)} or add ${provider} credentials via /auth`);
      continue;
    }

    lines.push(`    ${checks.join("  ")}`);
  }

  // ── Runtime ────────────────────────────────────────────────────────────────
  lines.push("");
  lines.push("Runtime");

  const healthy = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`)
    .then((r) => r.ok)
    .catch(() => false);

  if (healthy) {
    lines.push(`  ✓ Proxy healthy (port ${PROXY_PORT})`);
  } else {
    lines.push(`  ✗ Proxy not responding (port ${PROXY_PORT})`);
    lines.push("    → Restart gateway or check logs for proxy errors");
    issues++;
  }

  if (getIsRouterPrimary()) {
    lines.push("  ℹ Router is primary model");
  } else {
    lines.push("  ℹ Router is not primary model");
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  lines.push("");
  if (issues === 0) {
    lines.push("No issues found.");
  } else {
    lines.push(`Found ${issues} issue${issues === 1 ? "" : "s"}.`);
  }

  return { text: lines.join("\n") };
}

// ── Plugin registration ───────────────────────────────────────────────────────

let activeServer: Server | null = null;
let startTime = Date.now();

export default {
  id: PROVIDER_ID,
  name: "Claw LLM Router",
  version: "1.0.0",
  description:
    "Local prompt classifier that routes to the cheapest capable model. 15-dimension weighted scoring, super fast local routing. Direct to providers via your own API keys.",

  register(api: OpenClawPluginApi): void {
    const log = api.logger;

    log.info(`${LOG_PREFIX} Loading plugin...`);

    // 1. Register provider at runtime
    api.registerProvider(clawRouterProvider);
    log.info(`${LOG_PREFIX} Provider registered: ${PROVIDER_ID}`);

    // 2. Set runtime provider config
    if (!api.config.models) api.config.models = { providers: {} };
    if (!api.config.models.providers) api.config.models.providers = {};
    api.config.models.providers[PROVIDER_ID] = buildProviderConfig();
    log.info(`${LOG_PREFIX} Runtime config set`);

    // 3. Write to openclaw.json atomically (idempotent)
    injectModelsConfig(log);

    // 4. Inject auth profile placeholder
    injectAuthProfile(log);

    // 5. Auto-configure default tiers on first run
    if (!isTierConfigured()) {
      writeTierConfig(DEFAULT_TIERS);
      log.info(
        `${LOG_PREFIX} First run: default tier config written. Use /router setup to customize.`,
      );
    }

    // 5b. Warn about missing API keys (non-blocking)
    logApiKeyWarnings(log);

    // 6. Register service (manages proxy lifecycle with gateway)
    api.registerService({
      id: `${PROVIDER_ID}-proxy`,

      async start(): Promise<void> {
        try {
          activeServer = await startProxy(log);
          startTime = Date.now();
          const tiers = getTierStrings();
          log.info(`${LOG_PREFIX} Proxy started on port ${PROXY_PORT}`);
          log.info(`${LOG_PREFIX} SIMPLE    → ${tiers.SIMPLE}`);
          log.info(`${LOG_PREFIX} MEDIUM    → ${tiers.MEDIUM}`);
          log.info(`${LOG_PREFIX} COMPLEX   → ${tiers.COMPLEX}`);
          log.info(`${LOG_PREFIX} REASONING → ${tiers.REASONING}`);
        } catch (err: unknown) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === "EADDRINUSE") {
            log.warn(
              `${LOG_PREFIX} Port ${PROXY_PORT} already in use — another instance may be running`,
            );
          } else {
            log.error(`${LOG_PREFIX} Failed to start proxy: ${err}`);
          }
        }
      },

      async stop(): Promise<void> {
        if (!activeServer) return;
        await new Promise<void>((resolve, reject) => {
          activeServer!.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        activeServer = null;
        log.info(`${LOG_PREFIX} Proxy stopped, port ${PROXY_PORT} released`);
      },
    });

    // 7. Register /router command with subcommands
    api.registerCommand({
      name: "router",
      description: "Show router status, configure tiers, or run setup",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        const args = (ctx.args ?? ctx.commandBody ?? "").trim();

        if (args === "help") {
          return handleHelpCommand();
        }

        if (args === "setup") {
          return handleSetupCommand();
        }

        if (args === "doctor") {
          return handleDoctorCommand();
        }

        if (args.startsWith("set ")) {
          return handleSetCommand(args.slice("set ".length));
        }

        // Default: show status
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        const uptimeStr =
          uptime > 3600
            ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
            : `${Math.floor(uptime / 60)}m ${uptime % 60}s`;

        const healthy = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`)
          .then((r) => r.ok)
          .catch(() => false);

        const tiers = getTierStrings();

        return {
          text: [
            `Claw LLM Router`,
            `Status: ${healthy ? "running" : "not responding"} | Uptime: ${uptimeStr}`,
            ``,
            `SIMPLE    → ${tiers.SIMPLE}`,
            `MEDIUM    → ${tiers.MEDIUM}`,
            `COMPLEX   → ${tiers.COMPLEX}`,
            `REASONING → ${tiers.REASONING}`,
            ``,
            `Port: ${PROXY_PORT} | To switch: /model claw-llm-router/auto`,
            `Configure: /router setup | Set tier: /router set <TIER> <provider/model> | Diagnose: /router doctor`,
          ].join("\n"),
        };
      },
    });

    // 8. Register before_model_resolve hook for OAuth model override
    //    When the router is the primary model and Anthropic OAuth is detected,
    //    the proxy sets a pending model override before calling the gateway.
    //    This hook intercepts the agent session and redirects it to the actual
    //    Anthropic model, breaking the recursion loop.
    api.on(
      "before_model_resolve",
      (event: unknown, _ctx: unknown) => {
        const { prompt } = event as BeforeModelResolveEvent;
        if (!prompt) return;
        const override = consumeOverride(prompt);
        if (override) {
          log.info(
            `${LOG_PREFIX} Model override: ${override.provider}/${override.model} (via before_model_resolve hook)`,
          );
          return {
            modelOverride: override.model,
            providerOverride: override.provider,
          } as BeforeModelResolveResult;
        }
      },
      { priority: 100 }, // High priority to run before other hooks
    );
    log.info(`${LOG_PREFIX} Registered before_model_resolve hook for OAuth override`);

    log.info(`${LOG_PREFIX} Plugin ready — docs: ${DOCS_URL}`);
  },
};
