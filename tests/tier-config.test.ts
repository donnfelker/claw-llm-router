import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadApiKey, parseProfileCredential } from "../tier-config.js";

describe("loadApiKey", () => {
  // These tests use env vars (priority 1) to avoid filesystem dependencies.

  describe("OAuth detection via env var", () => {
    const envKey = "TESTPROVIDER_API_KEY";

    afterEach(() => {
      delete process.env[envKey];
    });

    it("detects OAuth token by sk-ant-oat01- prefix", () => {
      process.env[envKey] = "sk-ant-oat01-some-oauth-token";
      const result = loadApiKey("testprovider");
      assert.equal(result.key, "sk-ant-oat01-some-oauth-token");
      assert.equal(result.isOAuth, true);
    });

    it("returns isOAuth=false for regular API keys", () => {
      process.env[envKey] = "sk-ant-api03-regular-key";
      const result = loadApiKey("testprovider");
      assert.equal(result.key, "sk-ant-api03-regular-key");
      assert.equal(result.isOAuth, false);
    });

    it("returns isOAuth=false for non-Anthropic keys", () => {
      process.env[envKey] = "gsk_abc123";
      const result = loadApiKey("testprovider");
      assert.equal(result.key, "gsk_abc123");
      assert.equal(result.isOAuth, false);
    });

    it("returns empty key with isOAuth=false when no key found", () => {
      // Use a provider that won't have any auth configured
      const result = loadApiKey("nonexistent_provider_xyz_12345");
      assert.equal(result.key, "");
      assert.equal(result.isOAuth, false);
    });
  });

  describe("OAuth detection via env var for Anthropic", () => {
    afterEach(() => {
      delete process.env.ANTHROPIC_API_KEY;
    });

    it("detects Anthropic OAuth token passed via ANTHROPIC_API_KEY", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-oat01-test-token";
      const result = loadApiKey("anthropic");
      assert.equal(result.isOAuth, true);
    });

    it("returns isOAuth=false for direct Anthropic API key", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-api03-direct-key";
      const result = loadApiKey("anthropic");
      assert.equal(result.isOAuth, false);
    });
  });
});

// ── Regression tests: OAuth detection from auth-profiles.json profiles ──────
// These test the profile-parsing logic directly, independent of filesystem.
// The Anthropic issue: OAuth tokens stored with type:"token" (not "oauth")
// were not detected as OAuth, causing them to be sent as x-api-key (→ 401).

describe("parseProfileCredential", () => {
  // ── Anthropic OAuth regression ──────────────────────────────────────────────

  it("detects Anthropic OAuth token with type:'token' by prefix", () => {
    // OpenClaw stores Anthropic OAuth as type:"token", NOT type:"oauth"
    // This is the exact shape that caused the original bug
    const result = parseProfileCredential({
      type: "token",
      token: "sk-ant-oat01-real-oauth-token-here",
    });
    assert.ok(result, "Should return a result");
    assert.equal(result.key, "sk-ant-oat01-real-oauth-token-here");
    assert.equal(
      result.isOAuth,
      true,
      "Must detect OAuth by sk-ant-oat01- prefix even when type is 'token'",
    );
  });

  it("returns isOAuth=false for Anthropic direct API key with type:'token'", () => {
    const result = parseProfileCredential({
      type: "token",
      token: "sk-ant-api03-direct-key",
    });
    assert.ok(result);
    assert.equal(result.isOAuth, false);
  });

  it("returns isOAuth=false for Anthropic direct API key with type:'api_key'", () => {
    const result = parseProfileCredential({
      type: "api_key",
      key: "sk-ant-api03-direct-key",
    });
    assert.ok(result);
    assert.equal(result.key, "sk-ant-api03-direct-key");
    assert.equal(result.isOAuth, false);
  });

  // ── MiniMax OAuth ───────────────────────────────────────────────────────────

  it("detects MiniMax OAuth token with type:'oauth' and access field", () => {
    // MiniMax OAuth uses type:"oauth" with token in `access` field
    const result = parseProfileCredential({
      type: "oauth",
      access: "minimax-opaque-access-token",
    });
    assert.ok(result, "Should return a result");
    assert.equal(result.key, "minimax-opaque-access-token");
    assert.equal(result.isOAuth, true, "Must detect OAuth by type:'oauth'");
  });

  it("falls back to token field for type:'oauth' if access is missing", () => {
    const result = parseProfileCredential({
      type: "oauth",
      token: "fallback-token",
    });
    assert.ok(result);
    assert.equal(result.key, "fallback-token");
    assert.equal(result.isOAuth, true);
  });

  it("falls back to key field for type:'oauth' if access and token missing", () => {
    const result = parseProfileCredential({
      type: "oauth",
      key: "fallback-key",
    });
    assert.ok(result);
    assert.equal(result.key, "fallback-key");
    assert.equal(result.isOAuth, true);
  });

  // ── Non-OAuth profiles ──────────────────────────────────────────────────────

  it("does NOT read access field for non-OAuth profiles", () => {
    // Prevents picking up stale OAuth tokens from api_key profiles
    // that might have a leftover `access` field
    const result = parseProfileCredential({
      type: "api_key",
      key: "real-api-key",
      access: "stale-oauth-token",
    });
    assert.ok(result);
    assert.equal(result.key, "real-api-key", "Should use key, not access");
    assert.equal(result.isOAuth, false);
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────

  it("returns null for proxy-handles-auth placeholder", () => {
    const result = parseProfileCredential({
      type: "api_key",
      key: "proxy-handles-auth",
    });
    assert.equal(result, null);
  });

  it("returns null for empty profile", () => {
    const result = parseProfileCredential({});
    assert.equal(result, null);
  });

  it("returns null when all fields are undefined", () => {
    const result = parseProfileCredential({
      type: "api_key",
      token: undefined,
      key: undefined,
      access: undefined,
    });
    assert.equal(result, null);
  });
});
