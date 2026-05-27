// LLM provider abstraction. Faz 0: yalnız interface ve null/no-op implementasyon.
// Faz 1: AnthropicProvider implementasyonu eklenecek.

import type { Enrichment } from "../finding"

export type LlmInput = {
  // Finding kontekstinde gönderilecek bilgiler.
  rule: string
  category: string
  severity: string
  staticMessage: string
  staticImpact: string
  staticRecommendation: string
  // Kod snippet'i — file:line bağlamı.
  codeSnippet: string
  filePath: string
  lineNumber: number
  // Rol-bazlı prompt template anahtarı (örn: "security-reviewer", "qa-engineer")
  roleKey: string
}

export type LlmOptions = {
  model: string
  maxTokens: number
}

export type LlmOutput = {
  enrichment: Enrichment
  // Bütçe takibi için tahmini maliyet (USD). Provider tarafından sağlanır.
  estimatedCostUsd: number
}

export interface LlmProvider {
  name(): string
  enrich(input: LlmInput, opts: LlmOptions): Promise<LlmOutput>
}

// Hiçbir HTTP çağrısı yapmayan, varsayılan no-op implementasyon.
// LLM_ENABLED=false iken `enrich.ts` bu provider'ı asla çağırmaz; yine de defansif.
export class NullLlmProvider implements LlmProvider {
  name(): string {
    return "null"
  }
  async enrich(): Promise<LlmOutput> {
    throw new Error("NullLlmProvider.enrich çağrılmamalı — LLM enrichment kapalı.")
  }
}
