# Claw LLM Router — Agent Instructions

## What This Is

This is a **plugin for OpenClaw** — an AI chat application. The plugin acts as a cost-optimized LLM router that classifies user prompts by complexity (SIMPLE, MEDIUM, COMPLEX, REASONING) and routes them to the most cost-effective model for that tier. It runs as an in-process HTTP proxy inside the OpenClaw gateway.

OpenClaw sends chat completion requests to the router, which classifies the prompt, selects the appropriate provider/model, and forwards the request. If a provider fails, the router falls back through a chain of higher-tier models.

## Testing & Code Quality

- **`npm run check` must pass before completing any task** — this runs format, lint, typecheck, and tests in sequence. If any step fails, fix it before committing.
- Run all checks: `npm run check` (format + lint + typecheck + tests)
- Run tests only: `npm test`
- Run formatting check: `npm run format` (fix with `npm run format:fix`)
- Run linting: `npm run lint`
- Run type checking: `npm run typecheck`
- Never commit with failing checks
- **Formatting is enforced by CI.** Always run `npm run format` (or `npm run check`) before committing. If formatting fails, fix it with `npm run format:fix` and include the formatting changes in your commit.
- Tests use Node.js built-in test runner (`node:test`)
- **Test context**: All test data should reflect realistic OpenClaw usage. Conversations are between `user` and `assistant` (the LLM) — not between named people (e.g., "Alice", "Bob"). Packed context uses OpenClaw's format: `[Chat messages since your last reply - for context]` with `user:`/`assistant:` prefixed messages, followed by `[Current message - respond to this]`.

## Project Structure

```
├── index.ts                  # Plugin entry, OpenClaw registration, before_model_resolve hook
├── proxy.ts                  # HTTP proxy server, request routing, fallback chain
├── classifier.ts             # Rule-based prompt classifier (15-dimension scoring)
├── tier-config.ts            # Tier-to-model config, API key loading from auth stores
├── models.ts                 # Model definitions, port/provider constants
├── provider.ts               # OpenClaw provider plugin definition
├── router-config.json        # Tier configuration (auto-generated, do not edit manually)
├── router-logger.ts          # RouterLogger class — centralized [router] log formatting
├── providers/
│   ├── types.ts              # LLMProvider interface, PluginLogger, ChatMessage
│   ├── openai-compatible.ts  # Google, OpenAI, Groq, Mistral, DeepSeek, etc.
│   ├── anthropic.ts          # Anthropic Messages API (direct API key only)
│   ├── gateway.ts            # OpenClaw gateway fallback (OAuth tokens)
│   ├── model-override.ts     # In-process override store (prevents recursion)
│   └── index.ts              # Provider registry, resolveProvider(), callProvider()
├── docs/
│   ├── ARCHITECTURE.md       # Provider strategy, OAuth override mechanism
│   ├── PROVIDERS.md          # Step-by-step guide for adding new providers
│   └── CLASSIFIER.md         # Classifier architecture, dimensions, weights, extraction
└── tests/
```

## Key Conventions

- **Before making code changes**, read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) to understand the provider strategy, resolution logic, and OAuth model override mechanism. Follow the patterns documented there.
- Auth is never stored in the plugin — always read from OpenClaw's auth stores
- All providers implement `LLMProvider` from `providers/types.ts`
- Use `callProvider()` for piped HTTP responses
- Provider resolution: Anthropic OAuth → Gateway (with override if router is primary), Anthropic API key → Direct, else → OpenAI-compatible
- `before_model_resolve` hook in `index.ts` handles OAuth recursion prevention
- `setInterval` calls must use `.unref()` to avoid hanging test processes
- `OpenAICompatibleProvider` strips non-standard request fields (e.g., `store`) to avoid 400 errors
- Never keep unused files around "for reference." All code is stored in git history and can be retrieved with `git log` / `git show`. Delete dead code and unused files.

## Docs

Documentation lives in the `docs/` folder. **Keep docs in sync with code changes:**

- **`docs/ARCHITECTURE.md`** — When changing provider strategy, resolution logic, or the OAuth model override mechanism, update the corresponding sections.
- **`docs/PROVIDERS.md`** — When adding, removing, or changing a provider implementation, update the provider tables, auth info, and step-by-step guide.
- **`docs/CLASSIFIER.md`** — When changing classifier dimensions, weights, tier boundaries, confidence thresholds, or extraction logic, update the corresponding sections.

If you change code that is documented in `docs/`, update the docs in the same commit.

## Adding a New Provider

Most new providers are OpenAI-compatible and only require config changes (base URL, env var, tier suggestions). Providers with non-standard APIs or OAuth need additional work. Read `docs/PROVIDERS.md` for the full step-by-step guide including:

- The `LLMProvider` interface contract
- How to add well-known base URLs and env var mappings
- How provider resolution works (OAuth → Gateway, Anthropic → Direct, else → OpenAI-compatible)
- Request/response format requirements
- Auth resolution priority order
- How to handle OAuth credentials and gateway routing
