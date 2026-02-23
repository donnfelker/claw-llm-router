/**
 * Claw LLM Router — Provider Registry
 *
 * Resolves the correct provider based on model spec:
 *   1. Anthropic + OAuth token (sk-ant-oat01-*) → GatewayProvider
 *      - When router is NOT the primary model → plain gateway call
 *      - When router IS the primary model → gateway with model override
 *        (uses before_model_resolve hook to break recursion)
 *   2. Anthropic + direct API key → AnthropicProvider
 *   3. Everything else → OpenAICompatibleProvider
 */

import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import type { LLMProvider, PluginLogger, ChatMessage } from "./types.js";
import type { TierModelSpec } from "../tier-config.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { AnthropicProvider } from "./anthropic.js";
import { GatewayProvider } from "./gateway.js";
import {
  setPendingOverride,
  extractUserPromptFromBody,
} from "./model-override.js";
import { RouterLogger } from "../router-logger.js";

const openaiCompatibleProvider = new OpenAICompatibleProvider();
const anthropicProvider = new AnthropicProvider();
const gatewayProvider = new GatewayProvider();

const HOME = process.env.HOME ?? "";
const OPENCLAW_CONFIG_PATH = `${HOME}/.openclaw/openclaw.json`;

/**
 * Check if the router is set as the primary model.
 * When it is, gateway calls will recurse (gateway creates agent sessions
 * using the primary model → calls the router → calls gateway → loop).
 */
function isRouterPrimaryModel(): boolean {
  try {
    const raw = readFileSync(OPENCLAW_CONFIG_PATH, "utf8");
    const config = JSON.parse(raw) as {
      agents?: { defaults?: { model?: { primary?: string } } };
    };
    const primary = config.agents?.defaults?.model?.primary ?? "";
    return primary.startsWith("claw-llm-router");
  } catch {
    return false;
  }
}

let cachedIsRouterPrimary: boolean | undefined;
function getIsRouterPrimary(): boolean {
  if (cachedIsRouterPrimary === undefined) {
    cachedIsRouterPrimary = isRouterPrimaryModel();
  }
  return cachedIsRouterPrimary;
}

// Refresh the cache periodically (every 30s) in case config changes
const _cacheInterval = setInterval(() => { cachedIsRouterPrimary = undefined; }, 30_000);
_cacheInterval.unref?.();

/**
 * Gateway-with-override provider: routes through the gateway but sets a
 * pending model override so the before_model_resolve hook can redirect
 * the agent session to the actual Anthropic model (breaking the recursion).
 */
const gatewayOverrideProvider: LLMProvider = {
  name: "gateway-with-override",
  async chatCompletion(body, spec, stream, res, log): Promise<void> {
    const rlog = new RouterLogger(log);
    const fullSpec = spec as TierModelSpec;
    const userPrompt = extractUserPromptFromBody(body);
    if (!userPrompt) {
      log.warn("Gateway override: no user prompt found — override may not match");
    }
    rlog.override({ provider: fullSpec.provider, model: spec.modelId });
    setPendingOverride(userPrompt, spec.modelId, fullSpec.provider);
    await gatewayProvider.chatCompletion(body, spec, stream, res, log);
  },
};

export function resolveProvider(spec: TierModelSpec): LLMProvider {
  // Any provider with OAuth credentials → route through gateway
  // (gateway handles token refresh and API format conversion)
  if (spec.isOAuth) {
    if (getIsRouterPrimary()) {
      return gatewayOverrideProvider;
    }
    return gatewayProvider;
  }
  if (spec.isAnthropic) {
    return anthropicProvider;
  }
  return openaiCompatibleProvider;
}

export async function callProvider(
  spec: TierModelSpec,
  body: Record<string, unknown>,
  stream: boolean,
  res: ServerResponse,
  log: PluginLogger,
): Promise<void> {
  const rlog = new RouterLogger(log);
  const provider = resolveProvider(spec);
  rlog.provider({ name: provider.name, provider: spec.provider, model: spec.modelId });
  await provider.chatCompletion(body, spec, stream, res, log);
}

/**
 * Make a non-streaming LLM call and return the content text.
 * Used by the classifier for tier classification.
 */
export async function classifierCall(
  spec: TierModelSpec,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  log: PluginLogger,
): Promise<string> {
  const provider = resolveProvider(spec);
  const body = {
    messages,
    max_tokens: maxTokens,
    temperature: 0,
  };

  if (provider instanceof AnthropicProvider) {
    // Direct Anthropic API call
    const { convertMessages, buildAnthropicBody } = await import("./anthropic.js");
    const { system, messages: convertedMessages } = convertMessages(messages as ChatMessage[]);
    const anthropicBody = buildAnthropicBody(body, spec.modelId, system, convertedMessages);

    const url = `${spec.baseUrl}/messages`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": spec.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(anthropicBody),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Anthropic classifier ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await resp.json()) as {
      content: Array<{ type: string; text?: string }>;
    };
    return data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  }

  if (provider instanceof GatewayProvider || provider.name === "gateway-with-override") {
    // Gateway call — returns OpenAI format
    // For gateway-with-override, set the pending model override first
    if (provider.name === "gateway-with-override") {
      const lastUserMsg = messages.filter((m) => m.role === "user").pop()?.content ?? "";
      const promptStr = typeof lastUserMsg === "string" ? lastUserMsg : "";
      setPendingOverride(promptStr, spec.modelId, spec.provider);
      log.info(`Classifier: gateway override → ${spec.provider}/${spec.modelId}`);
    }

    const { getGatewayInfo } = await import("./gateway.js");
    const gw = getGatewayInfo();
    const modelId = `${spec.provider}/${spec.modelId}`;
    const url = `http://127.0.0.1:${gw.port}/v1/chat/completions`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${gw.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...body, model: modelId }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Gateway classifier ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  }

  // OpenAI-compatible — direct call
  const url = `${spec.baseUrl}/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${spec.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...body, model: spec.modelId }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Classifier ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

export { openaiCompatibleProvider, anthropicProvider, gatewayProvider };

// Export for testing
export { getIsRouterPrimary };
