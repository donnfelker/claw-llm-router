/**
 * Claw LLM Router — Gateway Fallback Provider
 *
 * Routes requests through the OpenClaw gateway instead of calling providers directly.
 * Used when:
 *   - Anthropic OAuth token (sk-ant-oat01-*) is detected (can't be used directly)
 *   - Direct provider calls fail and we need a fallback
 *
 * The gateway handles all provider-specific auth and format conversion.
 * Auth: Bearer {gateway.token} (gateway token, not provider token)
 * Model: {provider}/{modelId}
 */

import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import type { LLMProvider, PluginLogger } from "./types.js";
import { RouterLogger } from "../router-logger.js";

const HOME = process.env.HOME;
if (!HOME) throw new Error("[claw-llm-router] HOME environment variable not set");
const OPENCLAW_CONFIG_PATH = `${HOME}/.openclaw/openclaw.json`;

type GatewayInfo = { port: number; token: string };

export function getGatewayInfo(): GatewayInfo {
  try {
    const raw = readFileSync(OPENCLAW_CONFIG_PATH, "utf8");
    const config = JSON.parse(raw) as { gateway?: { port?: number; auth?: { token?: string } } };
    return {
      port: config.gateway?.port ?? 18789,
      token: config.gateway?.auth?.token ?? "",
    };
  } catch {
    return { port: 18789, token: "" };
  }
}

let hasWarnedGatewayFallback = false;

export class GatewayProvider implements LLMProvider {
  readonly name = "gateway";

  async chatCompletion(
    body: Record<string, unknown>,
    spec: { modelId: string; apiKey: string; baseUrl: string; provider?: string },
    stream: boolean,
    res: ServerResponse,
    log: PluginLogger,
  ): Promise<void> {
    if (!hasWarnedGatewayFallback) {
      log.warn(
        `Using gateway fallback for ${(spec as { provider?: string }).provider ?? "unknown"} — direct API key recommended for use as primary model`,
      );
      hasWarnedGatewayFallback = true;
    }

    const gw = getGatewayInfo();
    const provider = (spec as { provider?: string }).provider ?? "";
    const modelId = `${provider}/${spec.modelId}`;
    const url = `http://127.0.0.1:${gw.port}/v1/chat/completions`;

    const payload = { ...body, model: modelId, stream };

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

    const rlog = new RouterLogger(log);

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
      rlog.done({ model: modelId, via: "gateway", streamed: true });
    } else {
      const data = (await resp.json()) as Record<string, unknown>;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      const usage = (data.usage ?? {}) as Record<string, number>;
      rlog.done({
        model: modelId,
        via: "gateway",
        streamed: false,
        tokensIn: usage.prompt_tokens ?? "?",
        tokensOut: usage.completion_tokens ?? "?",
      });
    }
  }
}

// Export for testing
export function resetGatewayWarning(): void {
  hasWarnedGatewayFallback = false;
}
