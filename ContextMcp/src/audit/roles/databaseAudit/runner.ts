import fs from "fs"
import os from "os"
import path from "path"
import { CONFIG } from "../../../core/config"
import { runRoslyn } from "../../../core/roslynRunner"
import type { Finding } from "../../shared/finding"
import type { Severity } from "../../shared/severity"
import { compareSeverityDesc, meetsMinSeverity } from "../../shared/severity"
import { enrichFindings } from "../../shared/llm/enrich"

export type DatabaseAuditOptions = {
  minSeverity?: Severity
}

export type DatabaseAuditResult = {
  filesAnalyzed: number  // Roslyn tarafından raporlanmaz; toplam Finding'lerin distinct file sayısı
  summary: Record<Lowercase<Severity>, number>
  byRule: Record<string, number>
  findings: Finding[]
}

function runRoslynDbAudit(): Finding[] {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-db-audit-"))
  const outputPath = path.join(tmpDir, "findings.json")
  try {
    const result = runRoslyn("db-audit", [CONFIG.ROOT_DIR, outputPath])
    if (!result.ok) {
      process.stderr.write(`[db-audit] Roslyn çağrısı başarısız: ${result.reason}\n`)
      return []
    }
    if (!fs.existsSync(outputPath)) {
      process.stderr.write("[db-audit] Roslyn çıktı dosyası üretilmedi.\n")
      return []
    }
    const raw = fs.readFileSync(outputPath, "utf8")
    const parsed = JSON.parse(raw) as Finding[]
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    process.stderr.write(`[db-audit] Roslyn çıktısı parse edilemedi: ${(err as Error).message}\n`)
    return []
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

export async function runDatabaseAudit(
  options: DatabaseAuditOptions = {}
): Promise<DatabaseAuditResult> {
  const minSeverity = options.minSeverity ?? "Low"
  const all = runRoslynDbAudit()

  const filtered = all.filter((f) => meetsMinSeverity(f.severity, minSeverity))
  const enriched = await enrichFindings({ findings: filtered, roleKey: "database-engineer" })
  enriched.findings.sort((a, b) =>
    compareSeverityDesc(a.severity, b.severity) ||
    a.file.localeCompare(b.file) ||
    a.line - b.line
  )

  const summary: Record<Lowercase<Severity>, number> = {
    critical: 0, high: 0, medium: 0, low: 0, suggestion: 0,
  }
  const byRule: Record<string, number> = {}
  const distinctFiles = new Set<string>()
  for (const f of enriched.findings) {
    summary[f.severity.toLowerCase() as Lowercase<Severity>]++
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1
    distinctFiles.add(f.file)
  }

  return {
    filesAnalyzed: distinctFiles.size,
    summary,
    byRule,
    findings: enriched.findings,
  }
}
