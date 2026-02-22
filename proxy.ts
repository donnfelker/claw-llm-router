/**
 * Claw LLM Router — In-Process HTTP Proxy
 *
 * Runs inside the OpenClaw gateway process (no subprocess).
 * Classifies prompts locally, routes to any configured provider.
 *
 * Supports two routing modes:
 * - Anthropic: native API with OpenAI ↔ Anthropic format conversion
 * - All others: OpenAI-compatible forwarding (Google, OpenAI, Groq, Mistral, etc.)
 *
 * Auth is NEVER stored in the plugin — always read from OpenClaw's auth stores.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { classify, tierFromModelId, FALLBACK_CHAIN, type Tier } from "./classifier.js";
import { PROXY_PORT } from "./models.js";
import { loadTierConfig, loadApiKey, getClassifierModelSpec, type TierModelSpec } from "./tier-config.js";
import { llmClassify } from "./llm-classifier.js";

type PluginLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

const ANTHROPIC_VERSION = "2023-06-01";

// ── Message types ─────────────────────────────────────────────────────────────

type ChatMessage = { role: string; content: string | unknown };

function extractUserPrompt(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return (m.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join(" ");
      }
    }
  }
  return "";
}

function extractSystemPrompt(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join(" ");
}

function nonSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role === "user" || m.role === "assistant");
}

// ── Auth check ───────────────────────────────────────────────────────────────

function requireApiKey(spec: TierModelSpec, res: ServerResponse, log: PluginLogger): boolean {
  if (spec.apiKey) return true;
  const msg = `No API key found for provider "${spec.provider}". Check auth-profiles.json, auth.json, or env vars.`;
  log.error(`[auth] ${msg}`);
  if (!res.headersSent) {
    res.writeHead(401, { "Content-Type": "application/json" });
  }
  if (!res.writableEnded) {
    res.end(JSON.stringify({ error: { message: msg, type: "auth_error" } }));
  }
  return false;
}

// ── Anthropic headers ────────────────────────────────────────────────────────

function anthropicHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  // oat01 tokens use Bearer auth; api03 keys use x-api-key
  if (apiKey.startsWith("sk-ant-oat")) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  } else {
    headers["x-api-key"] = apiKey;
  }
  return headers;
}

// ── OpenAI-compatible route (Google, OpenAI, Groq, Mistral, etc.) ────────────

async function handleOpenAICompatibleRoute(
  spec: TierModelSpec,
  messages: ChatMessage[],
  maxTokens: number,
  stream: boolean,
  res: ServerResponse,
  log: PluginLogger,
): Promise<void> {
  const url = `${spec.baseUrl}/chat/completions`;
  const payload = {
    model: spec.modelId,
    messages,
    max_tokens: maxTokens,
    stream,
  };

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
    throw new Error(`${spec.provider} ${resp.status}: ${errText.slice(0, 300)}`);
  }

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });
    // OpenAI-compatible SSE — pipe directly
    const reader = resp.body?.getReader();
    if (!reader) throw new Error(`No response body from ${spec.provider}`);
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.writableEnded) res.write(decoder.decode(value, { stream: true }));
    }
    if (!res.writableEnded) res.end();
    log.info(`Streamed → ${spec.provider}/${spec.modelId}`);
  } else {
    const data = await resp.json() as Record<string, unknown>;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
    const usage = (data.usage ?? {}) as Record<string, number>;
    log.info(`Complete → ${spec.provider}/${spec.modelId} in=${usage.prompt_tokens ?? "?"} out=${usage.completion_tokens ?? "?"}`);
  }
}

// ── Anthropic route (native API + format conversion) ─────────────────────────

function openaiMessagesToAnthropic(
  messages: ChatMessage[],
): Array<{ role: string; content: string }> {
  return nonSystemMessages(messages).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: typeof m.content === "string"
      ? m.content
      : JSON.stringify(m.content),
  }));
}

function anthropicToOpenAI(
  anthropicResp: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const content = (anthropicResp.content as Array<{ text?: string }>);
  const text = content?.map((c) => c.text ?? "").join("") ?? "";
  const usage = anthropicResp.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  const id = `chatcmpl-${anthropicResp.id as string ?? Date.now()}`;

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: anthropicResp.stop_reason ?? "stop",
    }],
    usage: {
      prompt_tokens: usage?.input_tokens ?? 0,
      completion_tokens: usage?.output_tokens ?? 0,
      total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    },
  };
}

async function handleAnthropicStream(
  spec: TierModelSpec,
  messages: ChatMessage[],
  systemPrompt: string,
  maxTokens: number,
  res: ServerResponse,
  log: PluginLogger,
): Promise<void> {
  const reqId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const messagesUrl = `${spec.baseUrl}/messages`;

  const payload: Record<string, unknown> = {
    model: spec.modelId,
    max_tokens: maxTokens,
    messages: openaiMessagesToAnthropic(messages),
    stream: true,
  };
  if (systemPrompt) payload.system = systemPrompt;

  const resp = await fetch(messagesUrl, {
    method: "POST",
    headers: anthropicHeaders(spec.apiKey),
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic ${resp.status}: ${errText.slice(0, 300)}`);
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("No response body from Anthropic");

  const decoder = new TextDecoder();
  let buf = "";

  function sendChunk(text: string): void {
    if (res.writableEnded) return;
    const chunk = {
      id: reqId,
      object: "chat.completion.chunk",
      created,
      model: spec.modelId,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  function sendStop(): void {
    if (res.writableEnded) return;
    const chunk = {
      id: reqId,
      object: "chat.completion.chunk",
      created,
      model: spec.modelId,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }

  // Parse Anthropic SSE and convert to OpenAI SSE
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const json = line.slice(6).trim();
      if (!json) continue;
      try {
        const event = JSON.parse(json) as Record<string, unknown>;
        const type = event.type as string;

        if (type === "content_block_delta") {
          const delta = event.delta as { type: string; text?: string } | undefined;
          if (delta?.type === "text_delta" && delta.text) {
            sendChunk(delta.text);
          }
        } else if (type === "message_stop") {
          sendStop();
          break;
        } else if (type === "error") {
          throw new Error(`Anthropic stream error: ${JSON.stringify(event.error)}`);
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Anthropic stream error:")) throw e;
        // Ignore parse errors on non-JSON lines
      }
    }
  }

  if (!res.writableEnded) sendStop();
  log.info(`Streamed → ${spec.provider}/${spec.modelId}`);
}

async function handleAnthropicComplete(
  spec: TierModelSpec,
  messages: ChatMessage[],
  systemPrompt: string,
  maxTokens: number,
  res: ServerResponse,
  log: PluginLogger,
): Promise<void> {
  const messagesUrl = `${spec.baseUrl}/messages`;

  const payload: Record<string, unknown> = {
    model: spec.modelId,
    max_tokens: maxTokens,
    messages: openaiMessagesToAnthropic(messages),
  };
  if (systemPrompt) payload.system = systemPrompt;

  const resp = await fetch(messagesUrl, {
    method: "POST",
    headers: anthropicHeaders(spec.apiKey),
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json() as Record<string, unknown>;
  const openAIResp = anthropicToOpenAI(data, spec.modelId);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(openAIResp));

  const usage = openAIResp.usage as { prompt_tokens?: number; completion_tokens?: number };
  log.info(`Complete → ${spec.provider}/${spec.modelId} in=${usage.prompt_tokens ?? "?"} out=${usage.completion_tokens ?? "?"}`);
}

// ── Request router ────────────────────────────────────────────────────────────

async function handleChatCompletion(
  _req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  log: PluginLogger,
): Promise<void> {
  const messages = (body.messages ?? []) as ChatMessage[];
  const stream = (body.stream as boolean) ?? false;
  const maxTokens = (body.max_tokens as number) ?? 4096;
  const modelId = ((body.model as string) ?? "auto").replace("claw-llm-router/", "");

  const userPrompt = extractUserPrompt(messages);
  const systemPrompt = extractSystemPrompt(messages);

  // Determine tier
  let tier: Tier;
  const tierOverride = tierFromModelId(modelId);
  if (tierOverride) {
    tier = tierOverride;
    log.info(`Forced tier=${tier} (model=${modelId})`);
  } else {
    const result = classify(userPrompt, systemPrompt);
    tier = result.tier;
    log.info(
      `Classified tier=${tier} score=${result.score.toFixed(3)} conf=${result.confidence.toFixed(2)} signals=[${result.signals.slice(0, 3).join(", ")}]`,
    );

    // Hybrid classifier: if rule-based confidence is low, ask a cheap LLM
    if (result.needsLlmClassification) {
      try {
        const classifierSpec = getClassifierModelSpec((msg) => log.info(msg));
        if (classifierSpec.apiKey) {
          const llmTier = await llmClassify(userPrompt, classifierSpec, (msg) => log.info(msg));
          log.info(`LLM classifier override: ${tier} → ${llmTier} (rule-based conf=${result.confidence.toFixed(2)})`);
          tier = llmTier;
        } else {
          log.warn(`LLM classifier skipped: no API key for ${classifierSpec.provider}. Falling back to MEDIUM.`);
          tier = "MEDIUM";
        }
      } catch (err) {
        log.warn(`LLM classifier failed: ${err instanceof Error ? err.message : String(err)}. Falling back to MEDIUM.`);
        tier = "MEDIUM";
      }
    }
  }

  // Load tier config (reads fresh from openclaw.json on each request)
  const tierConfig = loadTierConfig((msg) => log.info(msg));

  // Fallback chain
  const chain = FALLBACK_CHAIN[tier];
  let lastError: Error | undefined;

  for (const attemptTier of chain) {
    const spec = tierConfig[attemptTier];
    try {
      // Check for API key before attempting the call
      if (!requireApiKey(spec, res, log)) return;

      if (spec.isAnthropic) {
        if (stream) {
          await handleAnthropicStream(spec, messages, systemPrompt, maxTokens, res, log);
        } else {
          await handleAnthropicComplete(spec, messages, systemPrompt, maxTokens, res, log);
        }
      } else {
        await handleOpenAICompatibleRoute(spec, messages, maxTokens, stream, res, log);
      }
      return; // success
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log.warn(`tier=${attemptTier} model=${spec.provider}/${spec.modelId} failed: ${lastError.message} — trying fallback`);
    }
  }

  log.error(`All tiers exhausted. Last error: ${lastError?.message}`);
  if (!res.headersSent) {
    res.writeHead(502, { "Content-Type": "application/json" });
  }
  if (!res.writableEnded) {
    res.end(JSON.stringify({
      error: { message: `All providers failed: ${lastError?.message}`, type: "router_error" },
    }));
  }
}

// ── Server ────────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const CREATED_AT = Math.floor(Date.now() / 1000);

export async function startProxy(log: PluginLogger): Promise<Server> {
  // Log credential availability at startup
  for (const provider of ["anthropic", "google", "openai", "groq"]) {
    loadApiKey(provider, (msg) => log.info(msg));
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Health check
      if (req.url === "/health" || req.url?.startsWith("/health?")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: "1.0.0" }));
        return;
      }

      // Models list
      if (req.url === "/v1/models" && req.method === "GET") {
        const { ROUTER_MODELS, PROVIDER_ID } = await import("./models.js");
        const models = ROUTER_MODELS.map((m) => ({
          id: m.id,
          object: "model",
          created: CREATED_AT,
          owned_by: PROVIDER_ID,
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: models }));
        return;
      }

      // Chat completions
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        const rawBody = await readBody(req);
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(rawBody.toString()) as Record<string, unknown>;
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Invalid JSON", type: "invalid_request" } }));
          return;
        }
        await handleChatCompletion(req, res, body, log);
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not found", type: "not_found" } }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Proxy error: ${msg}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: { message: msg, type: "proxy_error" } }));
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        log.warn(`Port ${PROXY_PORT} already in use — proxy may already be running`);
        reject(err);
      } else {
        reject(err);
      }
    });

    server.listen(PROXY_PORT, "127.0.0.1", () => {
      log.info(`Proxy started on http://127.0.0.1:${PROXY_PORT}`);
      resolve(server);
    });
  });
}
