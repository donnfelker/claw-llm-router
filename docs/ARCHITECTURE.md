# Architecture

```mermaid
flowchart LR
    subgraph Plugin ["claw-llm-router plugin"]
        IDX[index.ts<br/>Plugin Entry] --> PROXY[proxy.ts<br/>HTTP Proxy :8401]
        PROXY --> CLS[classifier.ts<br/>Rule-Based]
        PROXY --> CALL[providers/index.ts<br/>Provider Registry]
        CALL --> OAI[OpenAI-Compatible<br/>Provider]
        CALL --> ANT[Anthropic<br/>Provider]
        CALL --> GW[Gateway<br/>Provider]
        CALL --> GWO[Gateway + Override<br/>Provider]
    end

    OAI -->|Direct API| GOOGLE[Google Gemini]
    OAI -->|Direct API| OPENAI[OpenAI]
    OAI -->|Direct API| GROQ[Groq]
    OAI -->|Direct API| XAI[xAI Grok]
    OAI -->|Direct API| MINIMAX[MiniMax]
    OAI -->|Direct API| MOONSHOT[MoonShot Kimi]
    ANT -->|Direct API| ANTAPI[Anthropic API]
    GW -->|Via Gateway| GWSVC[OpenClaw Gateway]
    GWO -->|Via Gateway<br/>+ model override hook| GWSVC
```

## Provider Strategy

All providers implement the `LLMProvider` interface:

```typescript
interface LLMProvider {
  readonly name: string;
  chatCompletion(
    body: Record<string, unknown>,
    spec: { modelId: string; apiKey: string; baseUrl: string },
    stream: boolean,
    res: ServerResponse,
    log: PluginLogger,
  ): Promise<void>;
}
```

Provider resolution:

| Condition                                      | Provider                   | How It Works                                                         |
| ---------------------------------------------- | -------------------------- | -------------------------------------------------------------------- |
| Any provider + OAuth token                     | `GatewayProvider`          | Routes through OpenClaw gateway (handles token refresh + API format) |
| Any provider + OAuth + router is primary model | `gateway-with-override`    | Gateway call with `before_model_resolve` hook to prevent recursion   |
| Anthropic + direct API key                     | `AnthropicProvider`        | Converts OpenAI format to Anthropic Messages API                     |
| All other providers                            | `OpenAICompatibleProvider` | POST to `{baseUrl}/chat/completions` with Bearer auth                |

## OAuth Model Override (Recursion Prevention)

When the router is set as OpenClaw's primary model and Anthropic uses an OAuth token, a naive gateway call would cause infinite recursion:

```mermaid
sequenceDiagram
    participant U as User / OpenClaw
    participant GW as OpenClaw Gateway
    participant R as Router Proxy :8401
    participant OVR as before_model_resolve Hook
    participant A as Anthropic API

    U->>GW: POST /v1/chat/completions<br/>model: claw-llm-router/auto
    GW->>R: Forward to router proxy
    R->>R: Classify → MEDIUM
    R->>R: Resolve: Anthropic + OAuth + router is primary
    R->>R: Store pending override<br/>(prompt → anthropic/claude-haiku)
    R->>GW: POST /v1/chat/completions<br/>model: anthropic/claude-haiku
    Note over GW: Gateway creates agent session<br/>Normally uses primary model (router) → recursion!
    GW->>OVR: before_model_resolve fires
    OVR->>OVR: Match pending override by prompt
    OVR-->>GW: modelOverride: claude-haiku<br/>providerOverride: anthropic
    Note over GW: Model overridden ✓<br/>No recursion back to router
    GW->>A: Call Anthropic with OAuth
    A-->>GW: Response
    GW-->>R: Response
    R-->>GW: Response
    GW-->>U: Response
```

The override uses an in-process `Map` keyed by the first 500 characters of the user prompt. Entries auto-expire after 30 seconds.
