import type { Severity } from "./severity"

// Audit araçları için ortak Finding tipi.
// review/finding.ts ile aynı şekil; ek olarak opsiyonel `enrichment` alanı LLM çıktısını taşır.
// `category` open string — her aracın kendi kategorileri olabilir.

export type Enrichment = {
  insight: string
  relatedFiles?: string[]
  suggestedDiff?: string
  confidence: "high" | "medium" | "low"
  tokensUsed: number
}

export type Finding = {
  severity: Severity
  category: string
  file: string
  line: number
  rule: string
  message: string
  impact: string
  recommendation: string
  enrichment?: Enrichment
}
