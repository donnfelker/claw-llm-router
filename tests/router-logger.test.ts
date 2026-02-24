import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouterLogger } from "../router-logger.js";
import type { PluginLogger } from "../providers/types.js";

/** Capture log output into arrays by level. */
function makeCapture() {
  const messages: { level: string; msg: string }[] = [];
  const log: PluginLogger = {
    info: (msg) => messages.push({ level: "info", msg }),
    warn: (msg) => messages.push({ level: "warn", msg }),
    error: (msg) => messages.push({ level: "error", msg }),
  };
  return { messages, log };
}

describe("RouterLogger", () => {
  // ── request() ──────────────────────────────────────────────────────────────

  describe("request()", () => {
    it("logs model, stream flag, and prompt snippet", () => {
      const { messages, log } = makeCapture();
      const rlog = new RouterLogger(log);
      rlog.request({ model: "auto", stream: true, prompt: "Hello world" });

      assert.equal(messages.length, 1);
      assert.equal(messages[0].level, "info");
      assert.ok(messages[0].msg.startsWith("[claw-llm-router]"));
      assert.ok(messages[0].msg.includes("model=auto"));
      assert.ok(messages[0].msg.includes("stream=true"));
      assert.ok(messages[0].msg.includes('prompt="Hello world"'));
    });

    it("truncates prompt to 80 chars", () => {
      const { messages, log } = makeCapture();
      const rlog = new RouterLogger(log);
      const longPrompt = "x".repeat(200);
      rlog.request({ model: "auto", stream: false, prompt: longPrompt });

      // The prompt in the log should be exactly 80 chars
      const match = messages[0].msg.match(/prompt="([^"]+)"/);
      assert.ok(match);
      assert.equal(match[1].length, 80);
    });

    it("replaces newlines in prompt snippet", () => {
      const { messages, log } = makeCapture();
      const rlog = new RouterLogger(log);
      rlog.request({ model: "auto", stream: false, prompt: "line1\nline2\nline3" });

      assert.ok(!messages[0].msg.includes("\n"));
      assert.ok(messages[0].msg.includes("line1 line2 line3"));
    });

    it("includes extraction info when present", () => {
      const { messages, log } = makeCapture();
      const rlog = new RouterLogger(log);
      rlog.request({
        model: "auto",
        stream: false,
        prompt: "hello",
        extraction: { from: 5000, to: 5 },
      });

      assert.ok(messages[0].msg.includes("extracted 5 chars from 5000-char message"));
    });

    it("omits extraction info when absent", () => {
      const { messages, log } = makeCapture();
      const rlog = new RouterLogger(log);
      rlog.request({ model: "auto", stream: false, prompt: "hello" });

      assert.ok(!messages[0].msg.includes("extracted"));
    });
  });

  // ── classify() ─────────────────────────────────────────────────────────────

  describe("classify()", () => {
    it("logs tier and method", () => {
      const { messages, log } = makeCapture();
      const rlog = new RouterLogger(log);
      rlog.classify({ tier: "SIMPLE", method: "forced" });

      assert.equal(messages.length, 1);
      assert.ok(messages[0].msg.includes("[claw-llm-router] classify:"));
      assert.ok(messages[0].msg.includes("tier=SIMPLE"));
      assert.ok(messages[0].msg.includes("method=forced"));
    });

    it("formats score to 3 decimal places", () => {
      const { messages, log } = makeCapture();
      const rlog = new RouterLogger(log);
      rlog.classify({ tier: "MEDIUM", method: "rule-based", score: 0.1 });

      assert.ok(messages[0].msg.includes("score=0.100"));
    });

    it("formats confidence to 2 decimal places", () => {
      const { messages, log } = makeCapture();
      const rlog = new RouterLogger(log);
      rlog.classify({ tier: "COMPLEX", method: "rule-based", confidence: 0.9 });

      assert.ok(messages[0].msg.includes("conf=0.90"));
    });

    it("includes signals array", () => {
      const { messages, log } = makeCapture();
      const rlog = new RouterLogger(log);
      rlog.classify({
        tier: "COMPLEX",
        method: "rule-based",
        score: 0.5,
        confidence: 0.85,
        signals: ["code (```)", "reasoning (step by step)"],
      });

      assert.ok(messages[0].msg.includes("signals=[code (```), reasoning (step by step)]"));
    });

    it("includes detail string", () => {
      const { messages, log } = makeCapture();
      const rlog = new RouterLogger(log);
      rlog.classify({ tier: "SIMPLE", method: "forced", detail: "(model=simple)" });

      assert.ok(messages[0].msg.includes("(model=simple)"));
    });

    it("omits optional fields when not provided", () => {
      const { messages, log } = makeCapture();
      const rlog = new RouterLogger(log);
      rlog.classify({ tier: "MEDIUM", method: "packed-default" });

      assert.ok(!messages[0].msg.includes("score="));
      assert.ok(!messages[0].msg.includes("conf="));
      assert.ok(!messages[0].msg.includes("signals="));
    });
  });

  // ── route() ───────────────────────────────────────────────────────────────

  describe("route()", () => {
    it("logs tier, provider/model, method, and chain", () => {
      const { messages, log } = makeCapture();
      const rlog = new RouterLogger(log);
      rlog.route({
        tier: "SIMPLE",
        provider: "google",
        model: "gemini-2.5-flash",
        method: "rule-based",
        chain: ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"],
      });

      assert.ok(messages[0].msg.includes("[claw-llm-router] route:"));
      assert.ok(messages[0].msg.includes("tier=SIMPLE"));
      assert.ok(messages[0].msg.includes("google/gemini-2.5-flash"));
      assert.ok(messages[0].msg.includes("method=rule-based"));
      assert.ok(messages[0].msg.includes("chain=[SIMPLE → MEDIUM → COMPLEX → REASONING]"));
    });
  });

  // ── provider() ────────────────────────────────────────────────────────────

  describe("provider()", () => {
    it("logs provider name and target model", () => {
      const { messages, log } = makeCapture();
      const rlog = new RouterLogger(log);
      rlog.provider({ name: "openai-compatible", provider: "google", model: "gemini-2.5-flash" });

      assert.ok(messages[0].msg.includes("[claw-llm-router] provider:"));
      assert.ok(messages[0].msg.includes("openai-compatible"));
      assert.ok(messages[0].msg.includes("google/gemini-2.5-flash"));
    });
  });

  // ── override() ────────────────────────────────────────────────────────────

  describe("override()", () => {
    it("logs pending override target", () => {
      const { messages, log } = makeCapture();
      const rlog = new RouterLogger(log);
      rlog.override({ provider: "anthropic", model: "claude-sonnet-4-6" });

      assert.ok(messages[0].msg.includes("[claw-llm-router] override:"));
      assert.ok(messages[0].msg.includes("anthropic/claude-sonnet-4-6"));
    });
  });

  // ── done() ────────────────────────────────────────────────────────────────

  describe("done()", () => {
    it("logs streamed completion without tokens", () => {
      const { messages, log } = makeCapture();
      const rlog = new RouterLogger(log);
      rlog.done({ model: "gemini-2.5-flash", via: "direct", streamed: true });

      assert.ok(messages[0].msg.includes("[claw-llm-router] done:"));
      assert.ok(messages[0].msg.includes("gemini-2.5-flash"));
      assert.ok(messages[0].msg.includes("direct"));
      assert.ok(messages[0].msg.includes("streamed"));
      assert.ok(!messages[0].msg.includes("tokens="));
    });

    it("logs non-streamed completion with tokens", () => {
      const { messages, log } = makeCapture();
      const rlog = new RouterLogger(log);
      rlog.done({
        model: "gemini-2.5-flash",
        via: "direct",
        streamed: false,
        tokensIn: 150,
        tokensOut: 42,
      });

      assert.ok(messages[0].msg.includes("complete"));
      assert.ok(messages[0].msg.includes("tokens=150→42"));
    });

    it("handles string token values", () => {
      const { messages, log } = makeCapture();
      const rlog = new RouterLogger(log);
      rlog.done({ model: "test", via: "gateway", streamed: false, tokensIn: "?", tokensOut: "?" });

      assert.ok(messages[0].msg.includes("tokens=?→?"));
    });
  });

  // ── fallback() ────────────────────────────────────────────────────────────

  describe("fallback()", () => {
    it("logs warning with tier, provider, and error", () => {
      const { messages, log } = makeCapture();
      const rlog = new RouterLogger(log);
      rlog.fallback({
        tier: "SIMPLE",
        provider: "google",
        model: "gemini-2.5-flash",
        error: "connection refused",
      });

      assert.equal(messages[0].level, "warn");
      assert.ok(messages[0].msg.includes("[claw-llm-router] fallback:"));
      assert.ok(messages[0].msg.includes("SIMPLE"));
      assert.ok(messages[0].msg.includes("google/gemini-2.5-flash"));
      assert.ok(messages[0].msg.includes("connection refused"));
    });
  });

  // ── failed() ──────────────────────────────────────────────────────────────

  describe("failed()", () => {
    it("logs error with chain and last error", () => {
      const { messages, log } = makeCapture();
      const rlog = new RouterLogger(log);
      rlog.failed({ chain: ["SIMPLE", "MEDIUM", "COMPLEX"], error: "all timed out" });

      assert.equal(messages[0].level, "error");
      assert.ok(messages[0].msg.includes("[claw-llm-router] FAILED:"));
      assert.ok(messages[0].msg.includes("[SIMPLE → MEDIUM → COMPLEX]"));
      assert.ok(messages[0].msg.includes("all timed out"));
    });
  });
});
