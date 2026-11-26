// ── NEXUS//LLM-PROVIDER — open-source decoupling layer (SELFHOST-0929) ───────
// Operator order 2026-09-29: «سیستم به حالت سوددهی رسیده و به خاطر محدودیت‌های
// موجود پایدار نمی‌ماند — باید از نسخه‌های اوپن‌سورس استفاده کرد» — the sandbox
// is the ceiling (4th recycle in 72h proven in worklog). This module is the
// ONLY place that knows which brain answers:
//
//   LLM_PROVIDER=zaidev  (default — sandbox platform SDK, behavior unchanged)
//   LLM_PROVIDER=openai  LLM_BASE_URL=http://127.0.0.1:11434/v1
//                        LLM_MODEL=llama3.1        (any OpenAI-compatible:
//                         Ollama · vLLM · LM Studio · OpenRouter · LiteLLM ·
//                         llama.cpp server · Groq · Together ...)
//                        LLM_API_KEY=...           (optional; empty for Ollama)
//
// The shim mirrors the platform response shape
// ({ choices: [{ message: { content } }] }) so every existing call site
// (aiChat / aiSignalBrief / aiGovernorDecisions / probeNeuralLink / cron
// senior-review) stays UNTOUCHED — the provider is a one-env switch.

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export interface ChatOptions {
  messages: ChatMessage[];
  thinking?: { type: "enabled" | "disabled" };
  temperature?: number;
}
export type ChatResponse = { choices?: Array<{ message?: { content?: string } }> };

export interface LlmClient {
  chat: { completions: { create(opts: ChatOptions): Promise<ChatResponse> } };
}

/** Upper bound only — every caller already enforces its own tighter timeout. */
const PROVIDER_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 300_000);

function openaiClient(baseUrl: string, apiKey: string, model: string): LlmClient {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    chat: {
      completions: {
        async create(opts: ChatOptions): Promise<ChatResponse> {
          const body: Record<string, unknown> = { model, messages: opts.messages };
          if (typeof opts.temperature === "number") body.temperature = opts.temperature;
          // Best-effort mapping of the platform "thinking" flag; backends that
          // don't understand reasoning_effort simply ignore the unknown key.
          if (opts.thinking?.type === "enabled") body.reasoning_effort = "medium";
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
          });
          if (!res.ok) throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 200)}`);
          return (await res.json()) as ChatResponse;
        },
      },
    },
  };
}

export function providerName(): "zaidev" | "openai" {
  return (process.env.LLM_PROVIDER ?? "zaidev") === "openai" ? "openai" : "zaidev";
}

/** Unified client factory — one env switch, zero call-site changes. */
export async function makeLlmClient(): Promise<LlmClient> {
  if (providerName() === "openai") {
    const baseUrl = process.env.LLM_BASE_URL ?? "";
    if (!baseUrl) throw new Error("LLM_PROVIDER=openai requires LLM_BASE_URL (e.g. http://127.0.0.1:11434/v1)");
    return openaiClient(baseUrl, process.env.LLM_API_KEY ?? "", process.env.LLM_MODEL ?? "llama3.1");
  }
  const ZAI = (await import("z-ai-web-dev-sdk")).default;
  return (await ZAI.create()) as unknown as LlmClient;
}
