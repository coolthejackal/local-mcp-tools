import { buildSmartContext } from "../context/smartContext"
import type { Finding } from "./finding"
import type { Severity, Category } from "./severity"
import { compareSeverityDesc, meetsMinSeverity } from "./severity"
import { runTsRules, isTsFile } from "./ruleRunner"
import { isCsFile, runRoslynReview } from "./roslynBridge"

export type ReviewOptions = {
  categories?: Category[]
  minSeverity?: Severity
}

export type ReviewResult = {
  query: string
  filesReviewed: number
  summary: Record<Lowercase<Severity>, number>
  byCategory: Record<Category, number>
  findings: Finding[]
}

export function reviewCode(query: string, options: ReviewOptions = {}): ReviewResult {
  const minSeverity: Severity = options.minSeverity ?? "Low"

  const ranked = buildSmartContext(query)
  const files = ranked
    .map((r) => r.file)
    .filter((f) => f !== "__warning__")

  const tsFiles = files.filter(isTsFile)
  const csFiles = files.filter(isCsFile)

  const tsFindings = runTsRules(tsFiles, options.categories)
  const csFindings = runRoslynReview(csFiles, options.categories)

  const all = [...tsFindings, ...csFindings].filter((f) =>
    meetsMinSeverity(f.severity, minSeverity)
  )

  all.sort((a, b) => {
    const s = compareSeverityDesc(a.severity, b.severity)
    if (s !== 0) return s
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    return a.line - b.line
  })

  const summary: Record<Lowercase<Severity>, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    suggestion: 0,
  }
  const byCategory: Record<Category, number> = {
    Security: 0,
    Architecture: 0,
    Performance: 0,
    ErrorHandling: 0,
  }
  for (const f of all) {
    summary[f.severity.toLowerCase() as Lowercase<Severity>]++
    byCategory[f.category]++
  }

  return {
    query,
    filesReviewed: tsFiles.length + csFiles.length,
    summary,
    byCategory,
    findings: all,
  }
}
