import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import {
  AnthropicProvider,
  convertMessages,
  buildAnthropicBody,
  toOpenAIResponse,
  mapStopReason,
  buildStreamChunk,
} from "../../providers/anthropic.js";
import type { PluginLogger, ChatMessage } from "../../providers/types.js";

function makeLogger(): PluginLogger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    info: (msg: string) => messages.push(`INFO: ${msg}`),
    warn: (msg: string) => messages.push(`WARN: ${msg}`),
    error: (msg: string) => messages.push(`ERROR: ${msg}`),
  };
}

function makeRes(): ServerResponse & {
  _body: string;
  _statusCode: number;
  _headers: Record<string, string>;
  _ended: boolean;
} {
  const res = {
    _body: "",
    _statusCode: 0,
    _headers: {} as Record<string, string>,
    _ended: false,
    writableEnded: false,
  } as any;

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
    res.writableEnded = true;
    return res;
  };

  return res;
}

describe("convertMessages", () => {
  it("extracts system messages to top-level system param", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const result = convertMessages(messages);
    assert.equal(result.system, "You are helpful.");
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, "user");
    assert.equal(result.messages[0].content, "Hello");
  });

  it("joins multiple system messages", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Part 1" },
      { role: "system", content: "Part 2" },
      { role: "user", content: "Hello" },
    ];
    const result = convertMessages(messages);
    assert.equal(result.system, "Part 1\n\nPart 2");
  });

  it("returns undefined system when no system messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
    ];
    const result = convertMessages(messages);
    assert.equal(result.system, undefined);
    assert.equal(result.messages.length, 2);
  });

  it("handles array content (multimodal format)", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: " world" },
        ],
      },
    ];
    const result = convertMessages(messages);
    assert.equal(result.messages[0].content, "Hello world");
  });

  it("skips non-user/assistant/system roles", () => {
    const messages: ChatMessage[] = [
      { role: "tool", content: "tool result" },
      { role: "user", content: "Hello" },
    ];
    const result = convertMessages(messages);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, "user");
  });
});

describe("buildAnthropicBody", () => {
  it("sets model, messages, and max_tokens", () => {
    const body = { model: "gpt-4", messages: [], max_tokens: 100 };
    const messages = [{ role: "user" as const, content: "Hello" }];
    const result = buildAnthropicBody(body, "claude-sonnet-4-6", "Be helpful", messages);

    assert.equal(result.model, "claude-sonnet-4-6");
    assert.equal(result.system, "Be helpful");
    assert.equal(result.max_tokens, 100);
    assert.deepEqual(result.messages, messages);
  });

  it("defaults max_tokens to 8192 when not provided", () => {
    const body = { model: "gpt-4", messages: [] };
    const result = buildAnthropicBody(body, "claude-sonnet-4-6", undefined, []);
    assert.equal(result.max_tokens, 8192);
  });

  it("removes OpenAI-only params", () => {
    const body = {
      model: "gpt-4",
      messages: [],
      n: 2,
      frequency_penalty: 0.5,
      presence_penalty: 0.3,
      logprobs: true,
      temperature: 0.7,
    };
    const result = buildAnthropicBody(body, "claude-sonnet-4-6", undefined, []);

    assert.equal(result.n, undefined);
    assert.equal(result.frequency_penalty, undefined);
    assert.equal(result.presence_penalty, undefined);
    assert.equal(result.logprobs, undefined);
    assert.equal(result.temperature, 0.7); // should be kept
  });

  it("omits system when undefined", () => {
    const body = { model: "gpt-4", messages: [] };
    const result = buildAnthropicBody(body, "claude-sonnet-4-6", undefined, []);
    assert.equal("system" in result, false);
  });
});

describe("mapStopReason", () => {
  it("maps end_turn to stop", () => assert.equal(mapStopReason("end_turn"), "stop"));
  it("maps max_tokens to length", () => assert.equal(mapStopReason("max_tokens"), "length"));
  it("maps stop_sequence to stop", () => assert.equal(mapStopReason("stop_sequence"), "stop"));
  it("maps null to stop", () => assert.equal(mapStopReason(null), "stop"));
  it("maps unknown to stop", () => assert.equal(mapStopReason("unknown"), "stop"));
});

describe("toOpenAIResponse", () => {
  it("converts Anthropic response to OpenAI format", () => {
    const anthropic = {
      id: "msg_123",
      type: "message" as const,
      role: "assistant" as const,
      content: [{ type: "text", text: "Hello world" }],
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const result = toOpenAIResponse(anthropic);

    assert.equal(result.id, "chatcmpl-msg_123");
    assert.equal(result.object, "chat.completion");
    assert.equal(result.model, "claude-sonnet-4-6");

    const choices = result.choices as Array<{
      message: { role: string; content: string };
      finish_reason: string;
    }>;
    assert.equal(choices[0].message.role, "assistant");
    assert.equal(choices[0].message.content, "Hello world");
    assert.equal(choices[0].finish_reason, "stop");

    const usage = result.usage as {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    assert.equal(usage.prompt_tokens, 10);
    assert.equal(usage.completion_tokens, 5);
    assert.equal(usage.total_tokens, 15);
  });

  it("handles multiple content blocks", () => {
    const anthropic = {
      id: "msg_456",
      type: "message" as const,
      role: "assistant" as const,
      content: [
        { type: "text", text: "Part 1" },
        { type: "text", text: " Part 2" },
      ],
      model: "claude-sonnet-4-6",
      stop_reason: "max_tokens",
      usage: { input_tokens: 10, output_tokens: 10 },
    };

    const result = toOpenAIResponse(anthropic);
    const choices = result.choices as Array<{
      message: { content: string };
      finish_reason: string;
    }>;
    assert.equal(choices[0].message.content, "Part 1 Part 2");
    assert.equal(choices[0].finish_reason, "length");
  });
});

describe("buildStreamChunk", () => {
  it("builds a valid SSE chunk", () => {
    const chunk = buildStreamChunk("msg_123", "claude-sonnet-4-6", { content: "Hi" });
    assert.ok(chunk.startsWith("data: "));
    assert.ok(chunk.endsWith("\n\n"));

    const parsed = JSON.parse(chunk.slice(6));
    assert.equal(parsed.id, "chatcmpl-msg_123");
    assert.equal(parsed.object, "chat.completion.chunk");
    assert.equal(parsed.choices[0].delta.content, "Hi");
    assert.equal(parsed.choices[0].finish_reason, null);
  });

  it("includes finish_reason when provided", () => {
    const chunk = buildStreamChunk("msg_123", "claude-sonnet-4-6", {}, "stop");
    const parsed = JSON.parse(chunk.slice(6));
    assert.equal(parsed.choices[0].finish_reason, "stop");
  });
});

describe("AnthropicProvider", () => {
  const provider = new AnthropicProvider();
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("has correct name", () => {
    assert.equal(provider.name, "anthropic");
  });

  it("makes non-streaming call with correct headers and converts response", async () => {
    const anthropicResponse = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hi there!" }],
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      usage: { input_tokens: 8, output_tokens: 4 },
    };

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => anthropicResponse,
    })) as any;

    const log = makeLogger();
    const res = makeRes();

    await provider.chatCompletion(
      { messages: [{ role: "user", content: "hello" }], max_tokens: 100 },
      {
        modelId: "claude-sonnet-4-6",
        apiKey: "sk-ant-test",
        baseUrl: "https://api.anthropic.com/v1",
      },
      false,
      res,
      log,
    );

    assert.equal(res._statusCode, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.choices[0].message.content, "Hi there!");

    // Verify fetch was called with Anthropic-specific headers
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    assert.equal(fetchCall.arguments[0], "https://api.anthropic.com/v1/messages");
    const fetchOpts = fetchCall.arguments[1];
    assert.equal(fetchOpts.headers["x-api-key"], "sk-ant-test");
    assert.equal(fetchOpts.headers["anthropic-version"], "2023-06-01");
  });

  it("converts streaming Anthropic SSE to OpenAI format", async () => {
    const sseEvents = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-6","role":"assistant","content":[]}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const encoder = new TextEncoder();
    let readerDone = false;

    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (!readerDone) {
              readerDone = true;
              return { done: false, value: encoder.encode(sseEvents) };
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
      {
        modelId: "claude-sonnet-4-6",
        apiKey: "sk-ant-test",
        baseUrl: "https://api.anthropic.com/v1",
      },
      true,
      res,
      log,
    );

    assert.equal(res._statusCode, 200);
    assert.equal(res._headers["Content-Type"], "text/event-stream");

    // Should contain OpenAI-format chunks
    assert.ok(res._body.includes("chat.completion.chunk"));
    assert.ok(res._body.includes('"content":"Hello"'));
    assert.ok(res._body.includes("data: [DONE]"));
    assert.ok(res.writableEnded);
  });

  it("throws on non-OK response", async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "Invalid API key",
    })) as any;

    const log = makeLogger();
    const res = makeRes();

    await assert.rejects(
      () =>
        provider.chatCompletion(
          { messages: [{ role: "user", content: "hello" }] },
          {
            modelId: "claude-sonnet-4-6",
            apiKey: "bad-key",
            baseUrl: "https://api.anthropic.com/v1",
          },
          false,
          res,
          log,
        ),
      (err: Error) => {
        assert.ok(err.message.includes("401"));
        assert.ok(err.message.includes("Invalid API key"));
        return true;
      },
    );
  });
});
