import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { CONFIG } from "../../../core/config"
import type { Finding } from "../../shared/finding"
import type { Severity } from "../../shared/severity"
import { compareSeverityDesc, meetsMinSeverity } from "../../shared/severity"
import { enrichFindings } from "../../shared/llm/enrich"

const ROSLYN_PROJECT = path.resolve(__dirname, "../../../../../ContextMcp.Roslyn")
const CATEGORY = "TenantIsolation"

type EntityRecord = {
  name: string
  hasTenantIdProperty: boolean
  hasQueryFilter: boolean
  filterMentionsTenantId: boolean
  dbContextName: string | null
  file: string | null
  line: number
}

type IgnoreCall = { file: string; line: number; hasPrecedingComment: boolean }

type TenantIsolationResult = { entities: EntityRecord[]; ignoreCalls: IgnoreCall[] }

export type TenantIsolationOptions = {
  minSeverity?: Severity
}

export type TenantIsolationAuditResult = {
  entitiesAnalyzed: number
  summary: Record<Lowercase<Severity>, number>
  byRule: Record<string, number>
  findings: Finding[]
}

function runRoslynTenantIsolation(): TenantIsolationResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tenant-"))
  const outputPath = path.join(tmpDir, "result.json")
  try {
    try {
      execFileSync(
        "dotnet",
        ["run", "--project", ROSLYN_PROJECT, "--", "tenant-isolation", CONFIG.ROOT_DIR, outputPath],
        { stdio: ["ignore", "ignore", "inherit"] }
      )
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      process.stderr.write(`[tenant-isolation] Roslyn subprocess hata: ${e.message}\n`)
      return { entities: [], ignoreCalls: [] }
    }
    if (!fs.existsSync(outputPath)) return { entities: [], ignoreCalls: [] }
    return JSON.parse(fs.readFileSync(outputPath, "utf8")) as TenantIsolationResult
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

export async function runTenantIsolationAudit(
  options: TenantIsolationOptions = {}
): Promise<TenantIsolationAuditResult> {
  const minSeverity = options.minSeverity ?? "Low"
  const result = runRoslynTenantIsolation()

  const findings: Finding[] = []

  for (const e of result.entities) {
    if (!e.hasQueryFilter) {
      findings.push({
        severity: "High",
        category: CATEGORY,
        file: e.file ?? "(unknown)",
        line: e.line,
        rule: "entity-tenant-no-filter",
        message: `Entity '${e.name}' TenantId property'sine sahip ama HasQueryFilter tanımı yok.`,
        impact:
          "Filter eksikliği tenant-cross veri sızıntısına yol açar; admin/diagnostic " +
          "endpoint'leri bile diğer tenant'ların verisini gösterebilir.",
        recommendation:
          `OnModelCreating'de modelBuilder.Entity<${e.name}>().HasQueryFilter(x => x.TenantId == _tenantContext.TenantId) ` +
          "ekle. Filter bağlamı DI veya AmbientTenantContext üzerinden alınabilir.",
      })
    } else if (!e.filterMentionsTenantId) {
      findings.push({
        severity: "Medium",
        category: CATEGORY,
        file: e.file ?? "(unknown)",
        line: e.line,
        rule: "entity-filter-no-tenant-mention",
        message: `Entity '${e.name}' HasQueryFilter tanımı var ama TenantId kontrolü yok.`,
        impact:
          "Filter başka bir kolon için kurulmuş olabilir (soft-delete vb.); tenant " +
          "izolasyonu hâlâ eksik. Aynı filter içinde tenant kontrolü de zorunlu.",
        recommendation:
          "HasQueryFilter(x => !x.IsDeleted && x.TenantId == _tenant.Id) gibi bileşik filter kullan.",
      })
    }
  }

  for (const call of result.ignoreCalls) {
    if (!call.hasPrecedingComment) {
      findings.push({
        severity: "High",
        category: CATEGORY,
        file: call.file,
        line: call.line,
        rule: "ignore-query-filters-without-comment",
        message: ".IgnoreQueryFilters() çağrısı gerekçe yorumu olmadan kullanılıyor.",
        impact:
          "IgnoreQueryFilters tenant filter'ı bypass eder; bilinçsiz kullanım veri sızıntısı " +
          "açar. Code review'cı niyetin neden olduğunu göremez.",
        recommendation:
          "Çağrı satırının hemen üstüne kısa bir gerekçe yorumu yaz (örn: '// Admin: tüm tenant'lar listelenir').",
      })
    }
  }

  const filtered = findings.filter((f) => meetsMinSeverity(f.severity, minSeverity))
  const enriched = await enrichFindings({ findings: filtered, roleKey: "tenant-isolation-auditor" })
  enriched.findings.sort((a, b) => compareSeverityDesc(a.severity, b.severity) || a.file.localeCompare(b.file) || a.line - b.line)

  const summary: Record<Lowercase<Severity>, number> = {
    critical: 0, high: 0, medium: 0, low: 0, suggestion: 0,
  }
  const byRule: Record<string, number> = {}
  for (const f of enriched.findings) {
    summary[f.severity.toLowerCase() as Lowercase<Severity>]++
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1
  }

  return {
    entitiesAnalyzed: result.entities.length,
    summary,
    byRule,
    findings: enriched.findings,
  }
}
