import type { Severity, Category } from "./severity"

export type Finding = {
  severity: Severity
  category: Category
  file: string
  line: number
  rule: string
  message: string
  impact: string
  recommendation: string
}
