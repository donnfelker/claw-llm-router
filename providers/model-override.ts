/**
 * Claw LLM Router — In-Process Model Override Store
 *
 * When the router is the primary model AND Anthropic OAuth is detected,
 * direct gateway calls cause recursion (gateway creates agent sessions
 * using the primary model → routes back through the router).
 *
 * Solution: Before calling the gateway, store a pending model override
 * keyed by the user prompt. The plugin's `before_model_resolve` hook
 * consumes the override and tells the gateway to use the actual Anthropic
 * model instead of routing back through the router.
 *
 * Key = first 500 chars of the user prompt (enough for uniqueness).
 * Entries auto-expire after 30 seconds.
 */

const pendingOverrides = new Map<
  string,
  { model: string; provider: string; expires: number }
>();

function makeKey(prompt: string): string {
  return prompt.slice(0, 500);
}

export function setPendingOverride(
  prompt: string,
  model: string,
  provider: string,
): void {
  const key = makeKey(prompt);
  pendingOverrides.set(key, {
    model,
    provider,
    expires: Date.now() + 30_000,
  });
}

export function consumeOverride(
  prompt: string,
): { model: string; provider: string } | undefined {
  const key = makeKey(prompt);
  const entry = pendingOverrides.get(key);
  if (!entry) return undefined;
  pendingOverrides.delete(key);
  if (Date.now() > entry.expires) return undefined;
  return { model: entry.model, provider: entry.provider };
}

/**
 * Extract the last user message from a chat completion request body.
 * Used to generate the override key.
 */
export function extractUserPromptFromBody(
  body: Record<string, unknown>,
): string {
  const messages = (body.messages ?? []) as Array<{
    role: string;
    content: string | unknown;
  }>;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return (content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join(" ");
      }
    }
  }
  return "";
}

// Cleanup expired entries periodically
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingOverrides) {
    if (now > val.expires) pendingOverrides.delete(key);
  }
}, 60_000);
cleanupInterval.unref?.();

// For testing
export function clearOverrides(): void {
  pendingOverrides.clear();
}

export function pendingCount(): number {
  return pendingOverrides.size;
}
