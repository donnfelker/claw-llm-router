/**
 * Claw LLM Router — Provider Types
 *
 * Shared interface and types for all LLM providers.
 */

import type { ServerResponse } from "node:http";

export type PluginLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type ChatMessage = { role: string; content: string | unknown };

export interface LLMProvider {
  readonly name: string;
  chatCompletion(
    body: Record<string, unknown>,
    spec: { modelId: string; apiKey: string; baseUrl: string },
    stream: boolean,
    res: ServerResponse,
    log: PluginLogger,
  ): Promise<void>;
}
