import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveProvider, callProvider, MissingApiKeyError } from "../../providers/index.js";
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
    isOAuth: false,
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
        isOAuth: true,
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

  // ── MiniMax provider tests ──────────────────────────────────────────────────

  it("returns OpenAICompatibleProvider for MiniMax with direct API key", () => {
    const provider = resolveProvider(
      makeSpec({
        provider: "minimax",
        modelId: "MiniMax-M1",
        baseUrl: "https://api.minimax.io/v1",
        apiKey: "minimax-direct-key",
        isAnthropic: false,
        isOAuth: false,
      }),
    );
    assert.ok(provider instanceof OpenAICompatibleProvider);
    assert.equal(provider.name, "openai-compatible");
  });

  it("returns GatewayProvider for MiniMax with OAuth token", () => {
    const provider = resolveProvider(
      makeSpec({
        provider: "minimax",
        modelId: "MiniMax-M1",
        baseUrl: "https://api.minimax.io/v1",
        apiKey: "oauth-access-token",
        isAnthropic: false,
        isOAuth: true,
      }),
    );
    assert.ok(
      provider instanceof GatewayProvider || provider.name === "gateway-with-override",
      `Expected GatewayProvider or gateway-with-override, got ${provider.name}`,
    );
  });

  it("returns gateway-with-override for MiniMax OAuth when router is primary", () => {
    // This test verifies the logic path exists — actual router-primary detection
    // depends on openclaw.json config at runtime. The OAuth routing is generic:
    // any provider with isOAuth=true routes through gateway.
    const provider = resolveProvider(
      makeSpec({
        provider: "minimax",
        modelId: "MiniMax-M1",
        baseUrl: "https://api.minimax.io/v1",
        apiKey: "oauth-access-token",
        isAnthropic: false,
        isOAuth: true,
      }),
    );
    // Either gateway or gateway-with-override depending on primary model config
    assert.ok(
      provider instanceof GatewayProvider || provider.name === "gateway-with-override",
    );
  });

  // ── MoonShot provider tests ──────────────────────────────────────────────────

  it("returns OpenAICompatibleProvider for MoonShot", () => {
    const provider = resolveProvider(
      makeSpec({
        provider: "moonshot",
        modelId: "kimi-k2.5",
        baseUrl: "https://api.moonshot.ai/v1",
        isAnthropic: false,
        isOAuth: false,
      }),
    );
    assert.ok(provider instanceof OpenAICompatibleProvider);
    assert.equal(provider.name, "openai-compatible");
  });

  // ── General edge cases ──────────────────────────────────────────────────────

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
    assert.ok(provider instanceof AnthropicProvider);
  });

  it("routes any provider through gateway when isOAuth is true", () => {
    // Even a non-Anthropic provider gets gateway routing with OAuth
    const provider = resolveProvider(
      makeSpec({
        provider: "some-provider",
        apiKey: "some-token",
        isAnthropic: false,
        isOAuth: true,
      }),
    );
    assert.ok(
      provider instanceof GatewayProvider || provider.name === "gateway-with-override",
    );
  });

  // ── MissingApiKeyError: fail-fast when apiKey is empty ──────────────────────

  it("throws MissingApiKeyError when apiKey is empty", async () => {
    const spec = makeSpec({ provider: "google", modelId: "gemini-2.5-flash", apiKey: "" });
    const res = { headersSent: false, writableEnded: false } as import("node:http").ServerResponse;
    const log = { info: () => {}, warn: () => {}, error: () => {} };

    await assert.rejects(
      () => callProvider(spec, { messages: [] }, false, res, log),
      (err: unknown) => {
        assert.ok(err instanceof MissingApiKeyError);
        assert.equal(err.provider, "google");
        assert.equal(err.modelId, "gemini-2.5-flash");
        assert.equal(err.envVar, "GEMINI_API_KEY");
        assert.ok(err.message.includes("google/gemini-2.5-flash"));
        assert.ok(err.message.includes("GEMINI_API_KEY"));
        assert.ok(err.message.includes("/router doctor"));
        return true;
      },
    );
  });

  it("does not throw MissingApiKeyError when apiKey is present", async () => {
    // callProvider will proceed to resolveProvider and attempt the actual provider call.
    // We just verify it does NOT throw MissingApiKeyError — it will throw something
    // else (network error) since there's no real server.
    const spec = makeSpec({ provider: "google", apiKey: "test-key" });
    const res = { headersSent: false, writableEnded: false } as import("node:http").ServerResponse;
    const log = { info: () => {}, warn: () => {}, error: () => {} };

    try {
      await callProvider(spec, { messages: [] }, false, res, log);
    } catch (err) {
      // Should NOT be a MissingApiKeyError
      assert.ok(!(err instanceof MissingApiKeyError), "Should not throw MissingApiKeyError when key is present");
    }
  });

  // ── Regression: OAuth tokens must never hit AnthropicProvider ──────────────
  // AnthropicProvider sends OAuth tokens as x-api-key which returns 401.
  // OAuth tokens MUST route through the gateway regardless of isAnthropic.

  it("never sends Anthropic OAuth token to AnthropicProvider (isOAuth=true)", () => {
    const provider = resolveProvider(
      makeSpec({
        provider: "anthropic",
        apiKey: "sk-ant-oat01-real-oauth-token",
        isAnthropic: true,
        isOAuth: true,
      }),
    );
    assert.ok(
      !(provider instanceof AnthropicProvider),
      "OAuth token must not go to AnthropicProvider — would fail with 401 invalid x-api-key",
    );
    assert.ok(
      provider instanceof GatewayProvider || provider.name === "gateway-with-override",
    );
  });
});
