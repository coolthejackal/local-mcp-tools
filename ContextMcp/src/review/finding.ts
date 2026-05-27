import type { Severity, Category } from "./severity"
import type { Enrichment } from "../audit/shared/finding"

export type Finding = {
  severity: Severity
  category: Category
  file: string
  line: number
  rule: string
  message: string
  impact: string
  recommendation: string
  // Opsiyonel — yalnız LLM_ENABLED=true ve geçerli API key varken dolu.
  // Static analiz çıktısını bozmaz; bu alan yokken mevcut tüketiciler etkilenmez.
  enrichment?: Enrichment
}
