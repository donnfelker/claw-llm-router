/**
 * Claw LLM Router — In-Process HTTP Proxy
 *
 * Runs inside the OpenClaw gateway process (no subprocess).
 * Classifies prompts locally, then routes to the right model via
 * direct provider calls (OpenAI-compatible, Anthropic Messages API,
 * or gateway fallback for OAuth tokens).
 *
 * Auth is NEVER stored in the plugin — keys are read from OpenClaw's auth stores.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { classify, tierFromModelId, FALLBACK_CHAIN, type Tier } from "./classifier.js";
import { PROXY_PORT } from "./models.js";
import { loadTierConfig, getClassifierModelSpec } from "./tier-config.js";
import { llmClassify } from "./llm-classifier.js";
import { callProvider } from "./providers/index.js";
import type { PluginLogger, ChatMessage } from "./providers/types.js";

// ── Message extraction ───────────────────────────────────────────────────────

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

  // ── Extract classifiable prompt ──────────────────────────────────────────
  // The user message may contain more than just the user's input:
  //  1. Packed context (group chats / subagents): history + current message
  //  2. Embedded system prompt: system instructions prepended to user text
  // We need to isolate the actual user text for accurate classification.

  const isPackedContext = userPrompt.startsWith("[Chat messages since")
    || userPrompt.startsWith("[chat messages since");

  let classifiablePrompt = userPrompt;

  if (isPackedContext) {
    // Case 1: Packed context — extract text after the current-message marker
    const marker = "[Current message - respond to this]";
    const markerIdx = userPrompt.indexOf(marker);
    if (markerIdx !== -1) {
      classifiablePrompt = userPrompt.slice(markerIdx + marker.length).trim();
    }
  } else if (systemPrompt && userPrompt.length > systemPrompt.length) {
    // Case 2: System prompt embedded in user message — strip it
    // Some paths (e.g. webchat) prepend the system prompt to the user message
    // instead of sending it as a separate system-role message.
    const sysIdx = userPrompt.indexOf(systemPrompt);
    if (sysIdx !== -1) {
      const stripped = (
        userPrompt.slice(0, sysIdx) + userPrompt.slice(sysIdx + systemPrompt.length)
      ).trim();
      if (stripped) classifiablePrompt = stripped;
    }
  } else if (!systemPrompt && userPrompt.length > 500) {
    // Case 3: No separate system message and user message is suspiciously long.
    // The system prompt is likely embedded. The actual user text is at the end,
    // after the last paragraph break.
    const lastBreak = userPrompt.lastIndexOf("\n\n");
    if (lastBreak !== -1) {
      const tail = userPrompt.slice(lastBreak).trim();
      if (tail && tail.length < 500) {
        classifiablePrompt = tail;
      }
    }
  }

  // Determine tier
  let tier: Tier;
  const tierOverride = tierFromModelId(modelId);
  if (tierOverride) {
    tier = tierOverride;
    log.info(`Forced tier=${tier} (model=${modelId})`);
  } else if (isPackedContext && !classifiablePrompt) {
    // No current message marker found or empty — can't classify, default to MEDIUM
    tier = "MEDIUM";
    log.info(`Packed context detected (${userPrompt.length} chars, no current message marker) → default MEDIUM`);
  } else {
    const result = classify(classifiablePrompt);
    tier = result.tier;
    const extractionNote = classifiablePrompt !== userPrompt
      ? ` (extracted ${classifiablePrompt.length} chars from ${userPrompt.length}-char message)`
      : "";
    log.info(
      `Classified tier=${tier} score=${result.score.toFixed(3)} conf=${result.confidence.toFixed(2)} signals=[${result.signals.slice(0, 3).join(", ")}]${extractionNote}`,
    );

    // Hybrid classifier: if rule-based confidence is low, ask a cheap LLM
    if (result.needsLlmClassification) {
      try {
        const classifierSpec = getClassifierModelSpec((msg) => log.info(msg));
        if (classifierSpec.apiKey) {
          const llmTier = await llmClassify(classifiablePrompt, classifierSpec, (msg) => log.info(msg));
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
      await callProvider(spec, body, stream, res, log);
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
