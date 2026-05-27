import { getProgram } from "../../../ts/tsIncremental"
import type { Finding } from "../../shared/finding"
import type { Severity } from "../../shared/severity"
import { compareSeverityDesc, meetsMinSeverity } from "../../shared/severity"
import { findRelevantFiles } from "../../shared/queryDriven"
import { enrichFindings } from "../../shared/llm/enrich"
import { runAllRules } from "./rules"

export type FrontendComplianceOptions = {
  query: string
  categories?: string[]
  minSeverity?: Severity
}

export type FrontendComplianceResult = {
  query: string
  filesReviewed: number
  summary: Record<Lowercase<Severity>, number>
  byRule: Record<string, number>
  findings: Finding[]
}

const TS_EXT = [".ts", ".tsx", ".jsx"]

export async function runFrontendCompliance(
  options: FrontendComplianceOptions
): Promise<FrontendComplianceResult> {
  const minSeverity = options.minSeverity ?? "Low"
  const program = getProgram()

  const relevant = findRelevantFiles(options.query)
  // Frontend compliance yalnız JSX/TSX/JS dosyaları için anlamlı
  const frontendFiles = relevant.all.filter((f) => {
    const lower = f.toLowerCase()
    return TS_EXT.some((ext) => lower.endsWith(ext))
  })

  const findings: Finding[] = []
  for (const file of frontendFiles) {
    const sf = program.getSourceFile(file)
    if (!sf) continue
    try {
      findings.push(...runAllRules(sf, options.categories))
    } catch (err) {
      process.stderr.write(`[frontend-compliance] kural hatası ${file}: ${(err as Error).message}\n`)
    }
  }

  const filtered = findings.filter((f) => meetsMinSeverity(f.severity, minSeverity))

  const enriched = await enrichFindings({
    findings: filtered,
    roleKey: "frontend-compliance",
  })

  enriched.findings.sort((a, b) => {
    const s = compareSeverityDesc(a.severity, b.severity)
    if (s !== 0) return s
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    return a.line - b.line
  })

  const summary: Record<Lowercase<Severity>, number> = {
    critical: 0, high: 0, medium: 0, low: 0, suggestion: 0,
  }
  const byRule: Record<string, number> = {}
  for (const f of enriched.findings) {
    summary[f.severity.toLowerCase() as Lowercase<Severity>]++
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1
  }

  return {
    query: options.query,
    filesReviewed: frontendFiles.length,
    summary,
    byRule,
    findings: enriched.findings,
  }
}
