import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { ServerResponse } from "node:http";
import { GatewayProvider, resetGatewayWarning } from "../../providers/gateway.js";
import type { PluginLogger } from "../../providers/types.js";

function makeLogger(): PluginLogger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    info: (msg: string) => messages.push(`INFO: ${msg}`),
    warn: (msg: string) => messages.push(`WARN: ${msg}`),
    error: (msg: string) => messages.push(`ERROR: ${msg}`),
  };
}

function makeRes(): ServerResponse & { _body: string; _statusCode: number; _headers: Record<string, string>; _ended: boolean } {
  const res = new ServerResponse({ method: "POST" } as any) as any;
  res._body = "";
  res._statusCode = 0;
  res._headers = {};
  res._ended = false;

  res.writeHead = (statusCode: number, headers?: Record<string, string>) => {
    res._statusCode = statusCode;
    if (headers) res._headers = { ...res._headers, ...headers };
    return res;
  };
  res.write = (chunk: string | Buffer) => {
    res._body += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  res.end = (data?: string | Buffer) => {
    if (data) res._body += typeof data === "string" ? data : data.toString();
    res._ended = true;
    Object.defineProperty(res, "writableEnded", { value: true, configurable: true });
    return res;
  };

  return res;
}

describe("GatewayProvider", () => {
  const provider = new GatewayProvider();
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetGatewayWarning();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("has correct name", () => {
    assert.equal(provider.name, "gateway");
  });

  it("formats model ID as provider/modelId", async () => {
    const mockResponse = {
      id: "chatcmpl-gw",
      choices: [{ message: { content: "Hi" } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    };

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => mockResponse,
    })) as any;

    const log = makeLogger();
    const res = makeRes();

    await provider.chatCompletion(
      { messages: [{ role: "user", content: "hello" }] },
      { modelId: "claude-sonnet-4-6", apiKey: "sk-ant-oat01-test", baseUrl: "https://api.anthropic.com/v1", provider: "anthropic" } as any,
      false,
      res,
      log,
    );

    // Verify fetch was called with provider/modelId format
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    const sentBody = JSON.parse(fetchCall.arguments[1].body);
    assert.equal(sentBody.model, "anthropic/claude-sonnet-4-6");
  });

  it("uses gateway token, not provider API key", async () => {
    // This test relies on getGatewayInfo() reading openclaw.json
    // We can't easily mock that, but we can verify the provider token is NOT used
    const mockResponse = {
      id: "chatcmpl-gw",
      choices: [{ message: { content: "Hi" } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    };

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => mockResponse,
    })) as any;

    const log = makeLogger();
    const res = makeRes();

    await provider.chatCompletion(
      { messages: [] },
      { modelId: "claude-sonnet-4-6", apiKey: "sk-provider-key", baseUrl: "https://api.anthropic.com/v1", provider: "anthropic" } as any,
      false,
      res,
      log,
    );

    // Verify the Authorization header does NOT use the provider API key
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    const authHeader = fetchCall.arguments[1].headers["Authorization"];
    assert.ok(!authHeader.includes("sk-provider-key"), "Should use gateway token, not provider key");
  });

  it("logs warning on first use only", async () => {
    const mockResponse = {
      id: "chatcmpl-gw",
      choices: [{ message: { content: "Hi" } }],
      usage: {},
    };

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => mockResponse,
    })) as any;

    const log = makeLogger();
    const res1 = makeRes();
    const res2 = makeRes();

    await provider.chatCompletion(
      { messages: [] },
      { modelId: "claude-sonnet-4-6", apiKey: "key", baseUrl: "url", provider: "anthropic" } as any,
      false,
      res1,
      log,
    );

    await provider.chatCompletion(
      { messages: [] },
      { modelId: "claude-sonnet-4-6", apiKey: "key", baseUrl: "url", provider: "anthropic" } as any,
      false,
      res2,
      log,
    );

    const warnings = log.messages.filter((m) => m.startsWith("WARN:") && m.includes("gateway fallback"));
    assert.equal(warnings.length, 1, "Should only warn once");
  });

  it("throws on non-OK gateway response", async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "Internal server error",
    })) as any;

    const log = makeLogger();
    const res = makeRes();

    await assert.rejects(
      () =>
        provider.chatCompletion(
          { messages: [] },
          { modelId: "model", apiKey: "key", baseUrl: "url", provider: "test" } as any,
          false,
          res,
          log,
        ),
      (err: Error) => {
        assert.ok(err.message.includes("500"));
        assert.ok(err.message.includes("Gateway"));
        return true;
      },
    );
  });

  it("handles streaming via gateway", async () => {
    const sseData = 'data: {"id":"1","choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';
    const encoder = new TextEncoder();
    let readerDone = false;

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (!readerDone) {
              readerDone = true;
              return { done: false, value: encoder.encode(sseData) };
            }
            return { done: true, value: undefined };
          },
        }),
      },
    })) as any;

    const log = makeLogger();
    const res = makeRes();

    await provider.chatCompletion(
      { messages: [] },
      { modelId: "claude-sonnet-4-6", apiKey: "key", baseUrl: "url", provider: "anthropic" } as any,
      true,
      res,
      log,
    );

    assert.equal(res._statusCode, 200);
    assert.equal(res._headers["Content-Type"], "text/event-stream");
    assert.ok(res._body.includes("data:"));
    assert.ok(res.writableEnded);
  });
});
