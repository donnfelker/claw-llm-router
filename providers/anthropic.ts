/**
 * Claw LLM Router — Anthropic Messages API Provider
 *
 * Handles Anthropic models when the user has a direct API key (not OAuth).
 * Converts OpenAI chat completion format ↔ Anthropic Messages API format.
 */

import type { ServerResponse } from "node:http";
import type { LLMProvider, PluginLogger, ChatMessage } from "./types.js";
import { RouterLogger } from "../router-logger.js";

// ── OpenAI → Anthropic request conversion ────────────────────────────────────

type AnthropicMessage = { role: "user" | "assistant"; content: string };

function convertMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const converted: AnthropicMessage[] = [];

  for (const msg of messages) {
    const content = typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? (msg.content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("")
        : String(msg.content ?? "");

    if (msg.role === "system") {
      systemParts.push(content);
    } else if (msg.role === "user" || msg.role === "assistant") {
      converted.push({ role: msg.role, content });
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: converted,
  };
}

// Remove OpenAI-only params that Anthropic doesn't accept
const OPENAI_ONLY_PARAMS = new Set([
  "n", "frequency_penalty", "presence_penalty", "logprobs",
  "top_logprobs", "logit_bias", "response_format", "seed",
  "service_tier", "tools", "tool_choice", "parallel_tool_calls",
  "user", "store", "metadata", "stream_options",
]);

function buildAnthropicBody(
  body: Record<string, unknown>,
  modelId: string,
  systemText: string | undefined,
  messages: AnthropicMessage[],
): Record<string, unknown> {
  const anthropicBody: Record<string, unknown> = {};

  // Copy non-OpenAI-only params
  for (const [key, value] of Object.entries(body)) {
    if (key === "model" || key === "messages" || key === "stream" || OPENAI_ONLY_PARAMS.has(key)) {
      continue;
    }
    anthropicBody[key] = value;
  }

  anthropicBody.model = modelId;
  anthropicBody.messages = messages;
  if (systemText) anthropicBody.system = systemText;
  anthropicBody.max_tokens = (body.max_tokens as number) ?? 8192;

  return anthropicBody;
}

// ── Anthropic → OpenAI response conversion (non-streaming) ──────────────────

type AnthropicResponse = {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<{ type: string; text?: string }>;
  model: string;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
};

function mapStopReason(reason: string | null): string {
  switch (reason) {
    case "end_turn": return "stop";
    case "max_tokens": return "length";
    case "stop_sequence": return "stop";
    default: return "stop";
  }
}

function toOpenAIResponse(anthropic: AnthropicResponse): Record<string, unknown> {
  const text = anthropic.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");

  return {
    id: `chatcmpl-${anthropic.id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: anthropic.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: mapStopReason(anthropic.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: anthropic.usage.input_tokens,
      completion_tokens: anthropic.usage.output_tokens,
      total_tokens: anthropic.usage.input_tokens + anthropic.usage.output_tokens,
    },
  };
}

// ── Anthropic → OpenAI streaming SSE conversion ─────────────────────────────

function buildStreamChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  const chunk = {
    id: `chatcmpl-${id}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

async function convertAnthropicStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  res: ServerResponse,
  log: PluginLogger,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  let messageId = "";
  let model = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const dataStr = line.slice(6).trim();
      if (!dataStr || dataStr === "[DONE]") continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(dataStr) as Record<string, unknown>;
      } catch {
        continue;
      }

      const eventType = event.type as string;

      if (eventType === "message_start") {
        const msg = event.message as Record<string, unknown>;
        messageId = (msg.id as string) ?? "";
        model = (msg.model as string) ?? "";
        // Send initial chunk with role
        if (!res.writableEnded) {
          res.write(buildStreamChunk(messageId, model, { role: "assistant" }));
        }
      } else if (eventType === "content_block_delta") {
        const delta = event.delta as Record<string, unknown>;
        if (delta.type === "text_delta") {
          const text = delta.text as string;
          if (!res.writableEnded) {
            res.write(buildStreamChunk(messageId, model, { content: text }));
          }
        }
      } else if (eventType === "message_delta") {
        const delta = event.delta as Record<string, unknown>;
        const stopReason = delta.stop_reason as string | null;
        if (!res.writableEnded) {
          res.write(buildStreamChunk(messageId, model, {}, mapStopReason(stopReason)));
        }
      } else if (eventType === "message_stop") {
        if (!res.writableEnded) {
          res.write("data: [DONE]\n\n");
        }
      }
    }
  }

  // Flush any remaining buffered data
  if (buffer.trim()) {
    const line = buffer.trim();
    if (line.startsWith("data: ")) {
      const dataStr = line.slice(6).trim();
      if (dataStr && dataStr !== "[DONE]") {
        try {
          const event = JSON.parse(dataStr) as Record<string, unknown>;
          if (event.type === "message_stop" && !res.writableEnded) {
            res.write("data: [DONE]\n\n");
          }
        } catch {
          // ignore
        }
      }
    }
  }

  if (!res.writableEnded) res.end();
}

// ── Provider implementation ──────────────────────────────────────────────────

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";

  async chatCompletion(
    body: Record<string, unknown>,
    spec: { modelId: string; apiKey: string; baseUrl: string },
    stream: boolean,
    res: ServerResponse,
    log: PluginLogger,
  ): Promise<void> {
    const messages = (body.messages ?? []) as ChatMessage[];
    const { system, messages: convertedMessages } = convertMessages(messages);
    const anthropicBody = buildAnthropicBody(body, spec.modelId, system, convertedMessages);
    anthropicBody.stream = stream;

    const url = `${spec.baseUrl}/messages`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": spec.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(anthropicBody),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Anthropic ${spec.modelId} ${resp.status}: ${errText.slice(0, 300)}`);
    }

    const rlog = new RouterLogger(log);

    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      });
      const reader = resp.body?.getReader();
      if (!reader) throw new Error(`No response body from Anthropic ${spec.modelId}`);
      await convertAnthropicStream(reader, res, log);
      rlog.done({ model: spec.modelId, via: "anthropic", streamed: true });
    } else {
      const data = (await resp.json()) as AnthropicResponse;
      const openaiResponse = toOpenAIResponse(data);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(openaiResponse));
      rlog.done({
        model: spec.modelId,
        via: "anthropic",
        streamed: false,
        tokensIn: data.usage.input_tokens,
        tokensOut: data.usage.output_tokens,
      });
    }
  }
}

// Exported for testing
export { convertMessages, buildAnthropicBody, toOpenAIResponse, mapStopReason, buildStreamChunk };
