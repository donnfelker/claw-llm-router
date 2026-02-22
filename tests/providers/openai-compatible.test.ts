import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { ServerResponse } from "node:http";
import { OpenAICompatibleProvider } from "../../providers/openai-compatible.js";
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

describe("OpenAICompatibleProvider", () => {
  const provider = new OpenAICompatibleProvider();
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("has correct name", () => {
    assert.equal(provider.name, "openai-compatible");
  });

  it("forwards non-streaming request and pipes JSON response", async () => {
    const mockResponse = {
      id: "chatcmpl-test",
      object: "chat.completion",
      model: "gemini-2.5-flash",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => mockResponse,
    })) as any;

    const log = makeLogger();
    const res = makeRes();

    await provider.chatCompletion(
      { messages: [{ role: "user", content: "hello" }], max_tokens: 50 },
      { modelId: "gemini-2.5-flash", apiKey: "test-key", baseUrl: "https://api.example.com/v1" },
      false,
      res,
      log,
    );

    assert.equal(res._statusCode, 200);
    assert.equal(res._headers["Content-Type"], "application/json");
    const body = JSON.parse(res._body);
    assert.equal(body.choices[0].message.content, "Hello!");

    // Verify fetch was called with correct URL and headers
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    assert.equal(fetchCall.arguments[0], "https://api.example.com/v1/chat/completions");
    const fetchOpts = fetchCall.arguments[1];
    assert.equal(fetchOpts.headers["Authorization"], "Bearer test-key");

    // Verify model was overridden in payload
    const sentBody = JSON.parse(fetchOpts.body);
    assert.equal(sentBody.model, "gemini-2.5-flash");
    assert.equal(sentBody.stream, false);
  });

  it("sets correct streaming headers and pipes SSE", async () => {
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
      { messages: [{ role: "user", content: "hello" }] },
      { modelId: "gpt-4o", apiKey: "sk-test", baseUrl: "https://api.openai.com/v1" },
      true,
      res,
      log,
    );

    assert.equal(res._statusCode, 200);
    assert.equal(res._headers["Content-Type"], "text/event-stream");
    assert.equal(res._headers["Cache-Control"], "no-cache");
    assert.ok(res._body.includes("data:"));
    assert.ok(res.writableEnded);
  });

  it("throws on non-OK response", async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => "Rate limit exceeded",
    })) as any;

    const log = makeLogger();
    const res = makeRes();

    await assert.rejects(
      () =>
        provider.chatCompletion(
          { messages: [] },
          { modelId: "model", apiKey: "key", baseUrl: "https://api.example.com/v1" },
          false,
          res,
          log,
        ),
      (err: Error) => {
        assert.ok(err.message.includes("429"));
        assert.ok(err.message.includes("Rate limit"));
        return true;
      },
    );
  });

  it("throws when streaming body has no reader", async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      body: null,
    })) as any;

    const log = makeLogger();
    const res = makeRes();

    await assert.rejects(
      () =>
        provider.chatCompletion(
          { messages: [] },
          { modelId: "model", apiKey: "key", baseUrl: "https://api.example.com/v1" },
          true,
          res,
          log,
        ),
      /No response body/,
    );
  });
});
