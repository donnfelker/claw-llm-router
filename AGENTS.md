# Claw LLM Router — Agent Instructions

## Testing

- All tests must pass before completing any task
- Run all tests: `npx tsx --test tests/providers/*.test.ts tests/classifier.test.ts tests/proxy.test.ts`
- Provider tests only: `npx tsx --test tests/providers/*.test.ts`
- Classifier tests only: `npx tsx --test tests/classifier.test.ts`
- Never commit with failing tests
- Tests use Node.js built-in test runner (`node:test`) — no external deps

## Project Structure

```
├── index.ts                  # Plugin entry, OpenClaw registration, before_model_resolve hook
├── proxy.ts                  # HTTP proxy server, request routing, fallback chain
├── classifier.ts             # Rule-based prompt classifier (15-dimension scoring)
├── llm-classifier.ts         # LLM-based classifier for ambiguous prompts
├── tier-config.ts            # Tier-to-model config, API key loading from auth stores
├── models.ts                 # Model definitions, port/provider constants
├── provider.ts               # OpenClaw provider plugin definition
├── router-config.json        # Tier configuration (auto-generated, do not edit manually)
├── providers/
│   ├── types.ts              # LLMProvider interface, PluginLogger, ChatMessage
│   ├── openai-compatible.ts  # Google, OpenAI, Groq, Mistral, DeepSeek, etc.
│   ├── anthropic.ts          # Anthropic Messages API (direct API key only)
│   ├── gateway.ts            # OpenClaw gateway fallback (OAuth tokens)
│   ├── model-override.ts     # In-process override store (prevents recursion)
│   └── index.ts              # Provider registry, resolveProvider(), callProvider()
└── tests/
```

## Key Conventions

- Auth is never stored in the plugin — always read from OpenClaw's auth stores
- All providers implement `LLMProvider` from `providers/types.ts`
- Use `callProvider()` for piped HTTP responses, `classifierCall()` for non-streaming JSON
- Provider resolution: Anthropic OAuth → Gateway (with override if router is primary), Anthropic API key → Direct, else → OpenAI-compatible
- `before_model_resolve` hook in `index.ts` handles OAuth recursion prevention
- `setInterval` calls must use `.unref()` to avoid hanging test processes
- `OpenAICompatibleProvider` strips non-standard request fields (e.g., `store`) to avoid 400 errors
