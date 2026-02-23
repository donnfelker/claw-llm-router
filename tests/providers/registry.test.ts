import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveProvider } from "../../providers/index.js";
import { OpenAICompatibleProvider } from "../../providers/openai-compatible.js";
import { AnthropicProvider } from "../../providers/anthropic.js";
import { GatewayProvider } from "../../providers/gateway.js";
import type { TierModelSpec } from "../../tier-config.js";

function makeSpec(overrides: Partial<TierModelSpec> = {}): TierModelSpec {
  return {
    provider: "google",
    modelId: "gemini-2.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: "test-key",
    isAnthropic: false,
    ...overrides,
  };
}

describe("resolveProvider", () => {
  it("returns OpenAICompatibleProvider for Google", () => {
    const provider = resolveProvider(makeSpec({ provider: "google" }));
    assert.ok(provider instanceof OpenAICompatibleProvider);
    assert.equal(provider.name, "openai-compatible");
  });

  it("returns OpenAICompatibleProvider for OpenAI", () => {
    const provider = resolveProvider(
      makeSpec({ provider: "openai", baseUrl: "https://api.openai.com/v1", isAnthropic: false }),
    );
    assert.ok(provider instanceof OpenAICompatibleProvider);
  });

  it("returns OpenAICompatibleProvider for Groq", () => {
    const provider = resolveProvider(
      makeSpec({ provider: "groq", baseUrl: "https://api.groq.com/openai/v1", isAnthropic: false }),
    );
    assert.ok(provider instanceof OpenAICompatibleProvider);
  });

  it("returns AnthropicProvider for Anthropic with direct API key", () => {
    const provider = resolveProvider(
      makeSpec({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "sk-ant-api03-direct-key",
        isAnthropic: true,
      }),
    );
    assert.ok(provider instanceof AnthropicProvider);
    assert.equal(provider.name, "anthropic");
  });

  it("returns GatewayProvider or gateway-with-override for Anthropic with OAuth token", () => {
    const provider = resolveProvider(
      makeSpec({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "sk-ant-oat01-oauth-token-here",
        isAnthropic: true,
      }),
    );
    // When router is primary model → gateway-with-override; otherwise → gateway
    assert.ok(
      provider instanceof GatewayProvider || provider.name === "gateway-with-override",
      `Expected GatewayProvider or gateway-with-override, got ${provider.name}`,
    );
  });

  it("returns OpenAICompatibleProvider for xAI", () => {
    const provider = resolveProvider(
      makeSpec({ provider: "xai", baseUrl: "https://api.x.ai/v1", isAnthropic: false }),
    );
    assert.ok(provider instanceof OpenAICompatibleProvider);
    assert.equal(provider.name, "openai-compatible");
  });

  it("returns OpenAICompatibleProvider for unknown providers", () => {
    const provider = resolveProvider(
      makeSpec({ provider: "custom-provider", isAnthropic: false }),
    );
    assert.ok(provider instanceof OpenAICompatibleProvider);
  });

  it("returns AnthropicProvider for Anthropic with empty string key (non-OAuth)", () => {
    const provider = resolveProvider(
      makeSpec({
        provider: "anthropic",
        apiKey: "",
        isAnthropic: true,
      }),
    );
    // Empty key doesn't start with sk-ant-oat01-, so should get AnthropicProvider
    assert.ok(provider instanceof AnthropicProvider);
  });

  it("distinguishes OAuth prefix precisely", () => {
    // Key that starts with sk-ant- but NOT sk-ant-oat01-
    const provider = resolveProvider(
      makeSpec({
        provider: "anthropic",
        apiKey: "sk-ant-api03-some-regular-key",
        isAnthropic: true,
      }),
    );
    assert.ok(provider instanceof AnthropicProvider);
  });
});
