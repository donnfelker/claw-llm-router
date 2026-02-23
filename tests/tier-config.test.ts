import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadApiKey } from "../tier-config.js";

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
