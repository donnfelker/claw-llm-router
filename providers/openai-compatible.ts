/**
 * Claw LLM Router — OpenAI-Compatible Provider
 *
 * Handles: Google Gemini, OpenAI, Groq, Mistral, DeepSeek, Together,
 * Fireworks, Perplexity, xAI, and any other OpenAI-compatible API.
 *
 * POST to {baseUrl}/chat/completions with Bearer auth.
 * Forwards request body with only standard OpenAI chat completion params
 * (non-standard fields like `store` cause 400 errors on Google/Groq/etc).
 */

import type { ServerResponse } from "node:http";
import type { LLMProvider, PluginLogger } from "./types.js";

// Standard OpenAI chat completion parameters that providers generally accept.
// Non-standard or provider-specific fields (e.g. `store`, `metadata`) are stripped
// to avoid 400 errors from providers like Google Gemini.
const ALLOWED_PARAMS = new Set([
  "messages", "model", "stream",
  "max_tokens", "max_completion_tokens", "temperature", "top_p",
  "n", "stop", "presence_penalty", "frequency_penalty",
  "logit_bias", "logprobs", "top_logprobs",
  "response_format", "seed", "tools", "tool_choice",
  "parallel_tool_calls", "user", "stream_options",
  "service_tier",
]);

function sanitizeBody(body: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (ALLOWED_PARAMS.has(key)) {
      clean[key] = value;
    }
  }
  return clean;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = "openai-compatible";

  async chatCompletion(
    body: Record<string, unknown>,
    spec: { modelId: string; apiKey: string; baseUrl: string },
    stream: boolean,
    res: ServerResponse,
    log: PluginLogger,
  ): Promise<void> {
    const url = `${spec.baseUrl}/chat/completions`;
    const payload = { ...sanitizeBody(body), model: spec.modelId, stream };

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${spec.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`${spec.modelId} ${resp.status}: ${errText.slice(0, 300)}`);
    }

    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      });
      const reader = resp.body?.getReader();
      if (!reader) throw new Error(`No response body from ${spec.modelId}`);
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.writableEnded) res.write(decoder.decode(value, { stream: true }));
      }
      if (!res.writableEnded) res.end();
      log.info(`Streamed → ${spec.modelId} (direct)`);
    } else {
      const data = (await resp.json()) as Record<string, unknown>;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      const usage = (data.usage ?? {}) as Record<string, number>;
      log.info(
        `Complete → ${spec.modelId} (direct) in=${usage.prompt_tokens ?? "?"} out=${usage.completion_tokens ?? "?"}`,
      );
    }
  }
}
