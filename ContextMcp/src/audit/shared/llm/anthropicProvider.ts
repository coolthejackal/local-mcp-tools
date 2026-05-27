import type { Enrichment } from "../finding"
import type { LlmInput, LlmOptions, LlmOutput, LlmProvider } from "./llmProvider"
import { systemPromptFor, RESPONSE_SCHEMA } from "./promptTemplates"
import type { RoleKey } from "./promptTemplates"

// Anthropic SDK lazy-loaded — paket optionalDependencies içinde,
// LLM_ENABLED=true olmadan asla require edilmez.

// Tahmini token fiyatlandırması (USD / 1M token) — model bazlı.
// Bu sayılar yaklaşıktır; gerçek faturalama Anthropic dashboard'tan görülür.
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 0.25, output: 1.25 },
  "claude-haiku-4-5":          { input: 0.25, output: 1.25 },
  "claude-sonnet-4-6":         { input: 3.00, output: 15.00 },
  "claude-opus-4-7":           { input: 15.00, output: 75.00 },
}

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? PRICING["claude-haiku-4-5-20251001"]
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000
}

// Hardcoded-secret bulgusu için kod snippet'ini redact et — sırrı LLM'e gönderme.
function redactSnippet(rule: string, snippet: string): string {
  if (rule === "hardcoded-secret") {
    return "[REDACTED — hardcoded-secret bulgusu, gerçek değer LLM'e gönderilmiyor]"
  }
  return snippet
}

function buildUserPrompt(input: LlmInput): string {
  const snippet = redactSnippet(input.rule, input.codeSnippet)
  return [
    `Rule: ${input.rule}`,
    `Category: ${input.category}`,
    `Severity: ${input.severity}`,
    `File: ${input.filePath}:${input.lineNumber}`,
    "",
    "Static analysis output (already provided to the user):",
    `  Message:        ${input.staticMessage}`,
    `  Impact:         ${input.staticImpact}`,
    `  Recommendation: ${input.staticRecommendation}`,
    "",
    "Code snippet (with ~3 lines of context):",
    "```",
    snippet,
    "```",
    "",
    `Respond with a single JSON object matching this schema:`,
    JSON.stringify(RESPONSE_SCHEMA),
    "",
    "Field guidance:",
    "- insight: ONE deeper observation the static rule could not catch (≤120 words).",
    "- relatedFiles: optional, name files likely to be affected by the same problem.",
    "- suggestedDiff: optional minimal patch in unified-diff format if a clear fix exists.",
    "- confidence: how sure you are given the limited context.",
  ].join("\n")
}

type AnthropicMessage = {
  role: "user"
  content: string
}

type AnthropicSdkClient = {
  messages: {
    create(params: {
      model: string
      max_tokens: number
      system: string
      messages: AnthropicMessage[]
    }): Promise<{
      content: Array<{ type: string; text?: string }>
      usage?: { input_tokens?: number; output_tokens?: number }
    }>
  }
}

let cachedClient: AnthropicSdkClient | null = null

function loadClient(apiKey: string): AnthropicSdkClient | null {
  if (cachedClient) return cachedClient
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    // @ts-ignore — optional dependency, runtime require
    const sdk = require("@anthropic-ai/sdk")
    /* eslint-enable @typescript-eslint/no-require-imports */
    const Anthropic = sdk.default ?? sdk.Anthropic ?? sdk
    cachedClient = new Anthropic({ apiKey }) as AnthropicSdkClient
    return cachedClient
  } catch (err) {
    process.stderr.write(
      `[anthropic-provider] @anthropic-ai/sdk paketi yüklü değil — LLM enrichment için kur: ` +
      `npm install --save-optional @anthropic-ai/sdk\n` +
      `Hata: ${(err as Error).message}\n`
    )
    return null
  }
}

export class AnthropicProvider implements LlmProvider {
  private readonly apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  name(): string {
    return "anthropic"
  }

  async enrich(input: LlmInput, opts: LlmOptions): Promise<LlmOutput> {
    const client = loadClient(this.apiKey)
    if (!client) {
      throw new Error("Anthropic SDK yüklü değil — paketi kur veya LLM_ENABLED=false yap.")
    }

    const response = await client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: systemPromptFor(input.roleKey as RoleKey),
      messages: [{ role: "user", content: buildUserPrompt(input) }],
    })

    const text = response.content.find((c) => c.type === "text")?.text ?? ""
    const enrichment = parseEnrichment(text)

    const inputTokens = response.usage?.input_tokens ?? 0
    const outputTokens = response.usage?.output_tokens ?? 0
    enrichment.tokensUsed = inputTokens + outputTokens

    return {
      enrichment,
      estimatedCostUsd: estimateCost(opts.model, inputTokens, outputTokens),
    }
  }
}

function parseEnrichment(text: string): Enrichment {
  // JSON blok bul (LLM bazen kod fence içine sarar)
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const jsonText = fence ? fence[1] : text
  try {
    const parsed = JSON.parse(jsonText)
    return {
      insight: typeof parsed.insight === "string" ? parsed.insight : "insufficient_context",
      relatedFiles: Array.isArray(parsed.relatedFiles)
        ? parsed.relatedFiles.filter((f: unknown) => typeof f === "string")
        : undefined,
      suggestedDiff: typeof parsed.suggestedDiff === "string" ? parsed.suggestedDiff : undefined,
      confidence:
        parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
          ? parsed.confidence
          : "low",
      tokensUsed: 0,  // çağıran dolduracak
    }
  } catch {
    return {
      insight: text.trim().substring(0, 500) || "insufficient_context",
      confidence: "low",
      tokensUsed: 0,
    }
  }
}
