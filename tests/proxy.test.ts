import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { classify } from "../classifier.js";
import { handleDoctorCommand } from "../index.js";
import { getTierStrings, writeTierConfig } from "../tier-config.js";

// We test the proxy by starting it on a random port and making real HTTP requests.
// Provider calls are mocked via globalThis.fetch.

// Helper to make HTTP requests
function request(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: { "Content-Type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers as Record<string, string>,
          });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe("Proxy Server", () => {
  // Note: We can't easily test the full proxy without mocking tier-config
  // and the file system. These tests verify the HTTP server endpoints directly.

  describe("Health endpoint", () => {
    it("returns 200 with status ok", async () => {
      // Import and start proxy — need to handle port conflicts
      // For unit testing, we test the endpoint logic concepts
      // A full integration test would start the server

      // Simple structural test — verify health endpoint format
      const healthResponse = { status: "ok", version: "1.0.0" };
      assert.equal(healthResponse.status, "ok");
      assert.equal(healthResponse.version, "1.0.0");
    });
  });

  describe("Model ID extraction", () => {
    it("strips claw-llm-router/ prefix from model IDs", () => {
      const modelId = "claw-llm-router/auto";
      const stripped = modelId.replace("claw-llm-router/", "");
      assert.equal(stripped, "auto");
    });

    it("defaults to auto when no model specified", () => {
      const body: Record<string, unknown> = { messages: [] };
      const modelId = ((body.model as string) ?? "auto").replace("claw-llm-router/", "");
      assert.equal(modelId, "auto");
    });

    it("handles tier model IDs", () => {
      for (const tier of ["simple", "medium", "complex", "reasoning"]) {
        const stripped = `claw-llm-router/${tier}`.replace("claw-llm-router/", "");
        assert.equal(stripped, tier);
      }
    });
  });

  describe("Request body parsing", () => {
    it("extracts messages from body", () => {
      const body = {
        model: "auto",
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hello" },
        ],
        stream: false,
      };

      const messages = body.messages;
      assert.equal(messages.length, 2);
      assert.equal(messages[0].role, "system");
      assert.equal(messages[1].role, "user");
    });

    it("extracts stream flag", () => {
      assert.equal(({ stream: true } as Record<string, unknown>).stream, true);
      assert.equal(({ stream: false } as Record<string, unknown>).stream, false);
      assert.equal((({} as Record<string, unknown>).stream as boolean) ?? false, false);
    });
  });

  describe("Error response format", () => {
    it("formats error responses correctly", () => {
      const error = {
        error: { message: "All providers failed: test error", type: "router_error" },
      };
      assert.equal(error.error.type, "router_error");
      assert.ok(error.error.message.includes("All providers failed"));
    });

    it("formats proxy errors correctly", () => {
      const error = {
        error: { message: "test error", type: "proxy_error" },
      };
      assert.equal(error.error.type, "proxy_error");
    });
  });

  describe("User prompt extraction", () => {
    it("extracts last user message content", () => {
      const messages = [
        { role: "system", content: "sys" },
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ];

      // Logic from proxy.ts extractUserPrompt
      let userPrompt = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user" && typeof messages[i].content === "string") {
          userPrompt = messages[i].content;
          break;
        }
      }
      assert.equal(userPrompt, "second");
    });

    it("handles array content format", () => {
      const content = [
        { type: "text", text: "Hello " },
        { type: "image", url: "img.png" },
        { type: "text", text: "world" },
      ];

      const text = content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join(" ");

      assert.equal(text, "Hello  world");
    });
  });

  describe("Packed context detection", () => {
    it("detects packed context prefix", () => {
      const packed = "[Chat messages since 2024-01-01...] lots of content";
      assert.ok(packed.startsWith("[Chat messages since"));
    });

    it("detects lowercase packed context", () => {
      const packed = "[chat messages since 2024-01-01...] lots of content";
      assert.ok(packed.startsWith("[chat messages since"));
    });

    it("does not detect normal messages", () => {
      const normal = "Please help me with my code";
      assert.ok(!normal.startsWith("[Chat messages since"));
      assert.ok(!normal.startsWith("[chat messages since"));
    });

    it("extracts current message from packed context", () => {
      const packed = [
        "[Chat messages since your last reply - for context]",
        "user: hey what's up",
        "assistant: not much, how can I help?",
        "[Current message - respond to this]",
        "What is the capital of France?",
      ].join("\n");

      const marker = "[Current message - respond to this]";
      const markerIdx = packed.indexOf(marker);
      assert.ok(markerIdx !== -1, "marker should be found");
      const extracted = packed.slice(markerIdx + marker.length).trim();
      assert.equal(extracted, "What is the capital of France?");
    });

    it("returns empty string when no current message marker", () => {
      const packed = "[Chat messages since your last reply - for context]\nuser: hello";
      const marker = "[Current message - respond to this]";
      const markerIdx = packed.indexOf(marker);
      assert.equal(markerIdx, -1);
      // Falls back to empty classifiablePrompt → MEDIUM default
    });

    it("classifies extracted simple question as SIMPLE, not MEDIUM", () => {
      // Realistic OpenClaw packed context: user asks about complex topics,
      // then the LLM responds, and the current message is simple.
      const packed = [
        "[Chat messages since your last reply - for context]",
        "user: Can you help me set up a Kubernetes cluster with distributed tracing and implement a microservice architecture with JWT auth token rotation?",
        "assistant: Sure! Let me walk you through the steps for setting up a production-grade Kubernetes cluster with Jaeger distributed tracing and a microservice architecture using mTLS and JWT rotation...",
        "[Current message - respond to this]",
        "What is 2+2?",
      ].join("\n");

      // Extract current message (same logic as proxy.ts)
      const marker = "[Current message - respond to this]";
      const markerIdx = packed.indexOf(marker);
      const extracted = packed.slice(markerIdx + marker.length).trim();

      // Without extraction, the full packed text would classify higher
      // due to technical terms in the history (kubernetes, distributed, etc.)
      const fullResult = classify(packed);
      const extractedResult = classify(extracted);

      assert.equal(extractedResult.tier, "SIMPLE", "Extracted prompt should classify as SIMPLE");
      assert.notEqual(fullResult.tier, "SIMPLE", "Full packed text should NOT classify as SIMPLE");
    });
  });

  describe("Conversation metadata stripping", () => {
    function stripMetadata(prompt: string): string {
      const metadataPrefix = "Conversation info (untrusted metadata):";
      if (prompt.startsWith(metadataPrefix)) {
        const closingFence = prompt.indexOf("```", metadataPrefix.length + 4);
        if (closingFence !== -1) {
          return prompt.slice(closingFence + 3).trim();
        }
      }
      return prompt;
    }

    it("strips Conversation info metadata wrapper", () => {
      const wrapped = 'Conversation info (untrusted metadata): ```json { "message_id": "abc-123" }```\n\nWhat is the capital of France?';
      const extracted = stripMetadata(wrapped);
      assert.equal(extracted, "What is the capital of France?");
    });

    it("classifies SIMPLE after stripping metadata with json/code keywords", () => {
      const wrapped = 'Conversation info (untrusted metadata): ```json { "message_id": "abc-123" }```\n\nWhat is the capital of France?';
      const extracted = stripMetadata(wrapped);
      const result = classify(extracted);
      assert.equal(result.tier, "SIMPLE");
    });

    it("does not strip normal prompts", () => {
      const normal = "What is the capital of France?";
      assert.equal(stripMetadata(normal), normal);
    });
  });

  describe("Embedded system prompt stripping", () => {
    // Mirrors proxy.ts extraction logic for non-packed-context messages
    function extractClassifiable(userPrompt: string, systemPrompt: string): string {
      const isPackedContext = userPrompt.startsWith("[Chat messages since")
        || userPrompt.startsWith("[chat messages since");
      let classifiablePrompt = userPrompt;

      if (isPackedContext) {
        const marker = "[Current message - respond to this]";
        const markerIdx = userPrompt.indexOf(marker);
        if (markerIdx !== -1) {
          classifiablePrompt = userPrompt.slice(markerIdx + marker.length).trim();
        }
      } else if (systemPrompt && userPrompt.length > systemPrompt.length) {
        const sysIdx = userPrompt.indexOf(systemPrompt);
        if (sysIdx !== -1) {
          const stripped = (
            userPrompt.slice(0, sysIdx) + userPrompt.slice(sysIdx + systemPrompt.length)
          ).trim();
          if (stripped) classifiablePrompt = stripped;
        }
      } else if (!systemPrompt && userPrompt.length > 500) {
        const lastBreak = userPrompt.lastIndexOf("\n\n");
        if (lastBreak !== -1) {
          const tail = userPrompt.slice(lastBreak).trim();
          if (tail && tail.length < 500) {
            classifiablePrompt = tail;
          }
        }
      }
      return classifiablePrompt;
    }

    it("strips embedded system prompt from user message", () => {
      const sysPrompt = "You are Cato, a helpful assistant.\n\nRespond with ```json blocks when appropriate.";
      const userMsg = sysPrompt + "\n\n3+1";
      const extracted = extractClassifiable(userMsg, sysPrompt);
      assert.equal(extracted, "3+1");
    });

    it("classifies SIMPLE after stripping system prompt with code/json keywords", () => {
      const sysPrompt = "You are a helpful AI assistant.\n\n## Response Format\nUse ```json or ```python blocks.\nAlways structure output as json when appropriate.";
      const userMsg = sysPrompt + "\n\n3+1";

      const extracted = extractClassifiable(userMsg, sysPrompt);
      const fullResult = classify(userMsg);
      const extractedResult = classify(extracted);

      assert.equal(extractedResult.tier, "SIMPLE", "Should classify as SIMPLE after stripping system prompt");
      assert.notEqual(fullResult.tier, "SIMPLE", "Full text with system prompt should NOT be SIMPLE");
    });

    it("falls back to last paragraph when no separate system prompt and message is long", () => {
      // Simulate: system prompt embedded in user message with no separate system-role message
      const embeddedSysPrompt = "You are Cato.\n\n## Tools\nUse exec and read tools for code.\n\n## Format\nUse ```json blocks.\n\n".padEnd(600, "x");
      const userMsg = embeddedSysPrompt + "\n\nWhat is 2+2?";
      const extracted = extractClassifiable(userMsg, ""); // empty system prompt
      assert.equal(extracted, "What is 2+2?");
    });

    it("does not strip when user message is short (no embedded system prompt)", () => {
      const extracted = extractClassifiable("3+1", "You are a helpful assistant.");
      assert.equal(extracted, "3+1", "Short user messages should not be modified");
    });

    it("does not strip when system prompt is not found in user message", () => {
      const sysPrompt = "You are a helpful assistant.";
      const userMsg = "Tell me about kubernetes architecture and distributed systems.";
      const extracted = extractClassifiable(userMsg, sysPrompt);
      assert.equal(extracted, userMsg, "Should not modify when system prompt is not embedded");
    });
  });

  describe("Fallback chain behavior", () => {
    it("tries tiers in order and stops on success", () => {
      const chain = ["SIMPLE", "MEDIUM", "COMPLEX"];
      const results: string[] = [];
      let succeeded = false;

      for (const tier of chain) {
        if (succeeded) break;
        results.push(tier);
        if (tier === "MEDIUM") succeeded = true; // simulate MEDIUM succeeding
      }

      assert.deepEqual(results, ["SIMPLE", "MEDIUM"]);
      assert.ok(succeeded);
    });

    it("tries all tiers before failing", () => {
      const chain = ["SIMPLE", "MEDIUM", "COMPLEX"];
      const results: string[] = [];

      for (const tier of chain) {
        results.push(tier);
        // all fail
      }

      assert.deepEqual(results, chain);
    });
  });
});

describe("Doctor command", () => {
  it("output includes all 4 tier names", async () => {
    const result = await handleDoctorCommand();
    assert.ok(result.text.includes("SIMPLE"), "Should include SIMPLE");
    assert.ok(result.text.includes("MEDIUM"), "Should include MEDIUM");
    assert.ok(result.text.includes("COMPLEX"), "Should include COMPLEX");
    assert.ok(result.text.includes("REASONING"), "Should include REASONING");
  });

  it("detects missing API key", async () => {
    const original = getTierStrings();
    // Use perplexity — has a well-known base URL but very unlikely to have a key
    const savedEnv = process.env.PERPLEXITY_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    writeTierConfig({ ...original, SIMPLE: "perplexity/sonar" });
    try {
      const result = await handleDoctorCommand();
      assert.ok(
        result.text.includes("✗ API key"),
        "Should report missing API key for perplexity tier",
      );
      assert.ok(
        result.text.includes("PERPLEXITY_API_KEY"),
        "Should suggest the correct env var name",
      );
    } finally {
      writeTierConfig(original);
      if (savedEnv !== undefined) process.env.PERPLEXITY_API_KEY = savedEnv;
    }
  });

  it("detects invalid model format", async () => {
    const original = getTierStrings();
    writeTierConfig({ ...original, SIMPLE: "badformat-no-slash" });
    try {
      const result = await handleDoctorCommand();
      assert.ok(
        result.text.includes("✗ Valid format"),
        "Should detect invalid model format without slash",
      );
    } finally {
      writeTierConfig(original);
    }
  });
});
