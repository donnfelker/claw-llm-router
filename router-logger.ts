/**
 * Claw LLM Router — Structured Router Logger
 *
 * Wraps PluginLogger with domain-specific methods for each phase of the
 * routing pipeline. All output is prefixed with [claw-llm-router] for easy filtering.
 */

import type { PluginLogger } from "./providers/types.js";
import type { Tier } from "./classifier.js";

const PREFIX = "[claw-llm-router]";

export class RouterLogger {
  constructor(private log: PluginLogger) {}

  /** Incoming request received */
  request(opts: {
    model: string;
    stream: boolean;
    prompt: string;
    extraction?: { from: number; to: number };
  }): void {
    const snippet = opts.prompt.slice(0, 80).replace(/\n/g, " ");
    const ext = opts.extraction
      ? ` (extracted ${opts.extraction.to} chars from ${opts.extraction.from}-char message)`
      : "";
    this.log.info(
      `${PREFIX} ── request ── model=${opts.model} stream=${opts.stream} prompt="${snippet}"${ext}`,
    );
  }

  /** Rule-based classification result */
  classify(opts: {
    tier: Tier;
    method: string;
    score?: number;
    confidence?: number;
    signals?: string[];
    detail?: string;
  }): void {
    const parts = [`tier=${opts.tier}`, `method=${opts.method}`];
    if (opts.score !== undefined) parts.push(`score=${opts.score.toFixed(3)}`);
    if (opts.confidence !== undefined) parts.push(`conf=${opts.confidence.toFixed(2)}`);
    if (opts.signals?.length) parts.push(`signals=[${opts.signals.join(", ")}]`);
    if (opts.detail) parts.push(opts.detail);
    this.log.info(`${PREFIX} classify: ${parts.join(" ")}`);
  }

  /** Routing decision: which provider/model was selected */
  route(opts: {
    tier: Tier;
    provider: string;
    model: string;
    method: string;
    chain: string[];
  }): void {
    this.log.info(
      `${PREFIX} route: tier=${opts.tier} → ${opts.provider}/${opts.model} (method=${opts.method}, chain=[${opts.chain.join(" → ")}])`,
    );
  }

  /** Provider selected for the call */
  provider(opts: { name: string; provider: string; model: string }): void {
    this.log.info(`${PREFIX} provider: ${opts.name} for ${opts.provider}/${opts.model}`);
  }

  /** Gateway model override set */
  override(opts: { provider: string; model: string }): void {
    this.log.info(`${PREFIX} override: gateway pending override → ${opts.provider}/${opts.model}`);
  }

  /** Request completed successfully */
  done(opts: {
    model: string;
    via: string;
    streamed: boolean;
    tokensIn?: number | string;
    tokensOut?: number | string;
  }): void {
    const mode = opts.streamed ? "streamed" : "complete";
    const tokens =
      !opts.streamed && opts.tokensIn !== undefined
        ? ` tokens=${opts.tokensIn}→${opts.tokensOut}`
        : "";
    this.log.info(`${PREFIX} done: ${opts.model} (${opts.via}, ${mode})${tokens}`);
  }

  /** A tier attempt failed, trying fallback */
  fallback(opts: { tier: string; provider: string; model: string; error: string }): void {
    this.log.warn(
      `${PREFIX} fallback: ${opts.tier} ${opts.provider}/${opts.model} failed: ${opts.error}`,
    );
  }

  /** All tiers exhausted */
  failed(opts: { chain: string[]; error: string }): void {
    this.log.error(
      `${PREFIX} FAILED: all tiers exhausted [${opts.chain.join(" → ")}]. Last error: ${opts.error}`,
    );
  }
}
