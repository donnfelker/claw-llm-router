import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  setPendingOverride,
  consumeOverride,
  extractUserPromptFromBody,
  clearOverrides,
  pendingCount,
} from "../../providers/model-override.js";

describe("model-override", () => {
  beforeEach(() => {
    clearOverrides();
  });

  describe("setPendingOverride / consumeOverride", () => {
    it("sets and consumes an override by prompt key", () => {
      setPendingOverride("hello world", "claude-haiku-4-5-20251001", "anthropic");

      const result = consumeOverride("hello world");
      assert.deepEqual(result, {
        model: "claude-haiku-4-5-20251001",
        provider: "anthropic",
      });
    });

    it("returns undefined for unset prompts", () => {
      assert.equal(consumeOverride("no such prompt"), undefined);
    });

    it("consumes only once (removes after first consume)", () => {
      setPendingOverride("hello world", "claude-haiku-4-5-20251001", "anthropic");

      const first = consumeOverride("hello world");
      assert.ok(first);

      const second = consumeOverride("hello world");
      assert.equal(second, undefined);
    });

    it("handles multiple different prompts independently", () => {
      setPendingOverride("prompt-a", "claude-haiku-4-5-20251001", "anthropic");
      setPendingOverride("prompt-b", "claude-sonnet-4-6", "anthropic");

      assert.equal(pendingCount(), 2);

      const a = consumeOverride("prompt-a");
      assert.equal(a?.model, "claude-haiku-4-5-20251001");

      const b = consumeOverride("prompt-b");
      assert.equal(b?.model, "claude-sonnet-4-6");
    });

    it("uses first 500 chars as the key (long prompts)", () => {
      const longPrompt = "x".repeat(1000);
      setPendingOverride(longPrompt, "claude-haiku-4-5-20251001", "anthropic");

      // Same first 500 chars + different suffix → should still match
      const matchingPrompt = "x".repeat(500) + "y".repeat(500);
      const result = consumeOverride(matchingPrompt);
      assert.ok(result, "Should match on first 500 chars");
      assert.equal(result?.model, "claude-haiku-4-5-20251001");
    });

    it("overwrites previous override for same prompt key", () => {
      setPendingOverride("hello", "claude-haiku-4-5-20251001", "anthropic");
      setPendingOverride("hello", "claude-sonnet-4-6", "anthropic");

      const result = consumeOverride("hello");
      assert.equal(result?.model, "claude-sonnet-4-6");
      assert.equal(pendingCount(), 0);
    });
  });

  describe("clearOverrides", () => {
    it("removes all pending overrides", () => {
      setPendingOverride("a", "model-a", "provider-a");
      setPendingOverride("b", "model-b", "provider-b");
      assert.equal(pendingCount(), 2);

      clearOverrides();
      assert.equal(pendingCount(), 0);
    });
  });

  describe("extractUserPromptFromBody", () => {
    it("extracts last user message (string content)", () => {
      const body = {
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "first question" },
          { role: "assistant", content: "first answer" },
          { role: "user", content: "second question" },
        ],
      };
      assert.equal(extractUserPromptFromBody(body), "second question");
    });

    it("extracts last user message (array content with text parts)", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "part one" },
              { type: "image_url", image_url: "data:..." },
              { type: "text", text: "part two" },
            ],
          },
        ],
      };
      assert.equal(extractUserPromptFromBody(body), "part one part two");
    });

    it("returns empty string when no user messages", () => {
      const body = {
        messages: [{ role: "system", content: "system prompt" }],
      };
      assert.equal(extractUserPromptFromBody(body), "");
    });

    it("returns empty string for empty messages array", () => {
      assert.equal(extractUserPromptFromBody({ messages: [] }), "");
    });

    it("returns empty string when no messages key", () => {
      assert.equal(extractUserPromptFromBody({}), "");
    });
  });
});
