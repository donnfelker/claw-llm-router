/**
 * Claw LLM Router — In-Process HTTP Proxy
 *
 * Runs inside the OpenClaw gateway process (no subprocess).
 * Classifies prompts locally, then routes to the right model by forwarding
 * through the OpenClaw gateway's own /v1/chat/completions endpoint.
 *
 * This means the proxy does NOT handle provider-specific auth or format
 * conversion — the gateway handles all of that. The proxy just adds
 * intelligent model selection on top.
 *
 * Auth is NEVER stored in the plugin — the gateway handles all provider auth.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { classify, tierFromModelId, FALLBACK_CHAIN, type Tier } from "./classifier.js";
import { PROXY_PORT } from "./models.js";
import { loadTierConfig, getClassifierModelSpec, type TierModelSpec } from "./tier-config.js";
import { llmClassify } from "./llm-classifier.js";

type PluginLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

// ── Gateway config ───────────────────────────────────────────────────────────

const HOME = process.env.HOME;
if (!HOME) throw new Error("[claw-llm-router] HOME environment variable not set");
const OPENCLAW_CONFIG_PATH = `${HOME}/.openclaw/openclaw.json`;

type GatewayInfo = { port: number; token: string };

function getGatewayInfo(): GatewayInfo {
  const raw = readFileSync(OPENCLAW_CONFIG_PATH, "utf8");
  const config = JSON.parse(raw) as { gateway?: { port?: number; auth?: { token?: string } } };
  return {
    port: config.gateway?.port ?? 18789,
    token: config.gateway?.auth?.token ?? "",
  };
}

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

// ── Route through OpenClaw gateway ───────────────────────────────────────────
// The gateway handles all provider-specific auth and format conversion.
// We just forward the request with the right model ID.

async function routeThroughGateway(
  spec: TierModelSpec,
  body: Record<string, unknown>,
  stream: boolean,
  res: ServerResponse,
  log: PluginLogger,
): Promise<void> {
  const gw = getGatewayInfo();
  const modelId = `${spec.provider}/${spec.modelId}`;
  const url = `http://127.0.0.1:${gw.port}/v1/chat/completions`;

  const payload = {
    ...body,
    model: modelId,
    stream,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${gw.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gateway → ${modelId} ${resp.status}: ${errText.slice(0, 300)}`);
  }

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });
    const reader = resp.body?.getReader();
    if (!reader) throw new Error(`No response body from gateway for ${modelId}`);
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.writableEnded) res.write(decoder.decode(value, { stream: true }));
    }
    if (!res.writableEnded) res.end();
    log.info(`Streamed → ${modelId}`);
  } else {
    const data = await resp.json() as Record<string, unknown>;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
    const usage = (data.usage ?? {}) as Record<string, number>;
    log.info(`Complete → ${modelId} in=${usage.prompt_tokens ?? "?"} out=${usage.completion_tokens ?? "?"}`);
  }
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

  // Load tier config
  const tierConfig = loadTierConfig((msg) => log.info(msg));

  // Fallback chain
  const chain = FALLBACK_CHAIN[tier];
  let lastError: Error | undefined;

  for (const attemptTier of chain) {
    const spec = tierConfig[attemptTier];
    try {
      await routeThroughGateway(spec, body, stream, res, log);
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
