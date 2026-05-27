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
const CATEGORY = "DomainEvents"

type Publisher = { eventType: string; file: string; line: number; project: string | null }
type Consumer = { eventType: string; handlerClass: string; file: string; line: number; project: string | null }
type RoslynResult = { publishers: Publisher[]; consumers: Consumer[] }

export type DomainEventsMapOptions = {
  minSeverity?: Severity
}

export type DomainEventsMapResult = {
  publisherCount: number
  consumerCount: number
  eventTypeCount: number
  graph: Array<{
    eventType: string
    publishers: Array<{ project: string | null; file: string; line: number }>
    consumers: Array<{ handlerClass: string; project: string | null; file: string; line: number }>
  }>
  summary: Record<Lowercase<Severity>, number>
  byRule: Record<string, number>
  findings: Finding[]
}

function runRoslynDomainEvents(): RoslynResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-domain-events-"))
  const outputPath = path.join(tmpDir, "result.json")
  try {
    try {
      execFileSync(
        "dotnet",
        ["run", "--project", ROSLYN_PROJECT, "--", "domain-events", CONFIG.ROOT_DIR, outputPath],
        { stdio: ["ignore", "ignore", "inherit"] }
      )
    } catch (err) {
      process.stderr.write(`[domain-events] Roslyn subprocess hata: ${(err as Error).message}\n`)
      return { publishers: [], consumers: [] }
    }
    if (!fs.existsSync(outputPath)) return { publishers: [], consumers: [] }
    return JSON.parse(fs.readFileSync(outputPath, "utf8")) as RoslynResult
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

export async function runDomainEventsMap(
  options: DomainEventsMapOptions = {}
): Promise<DomainEventsMapResult> {
  const minSeverity = options.minSeverity ?? "Low"
  const result = runRoslynDomainEvents()

  // Event type üzerinde grupla
  const types = new Set<string>([
    ...result.publishers.map((p) => p.eventType),
    ...result.consumers.map((c) => c.eventType),
  ])

  const findings: Finding[] = []
  const graph: DomainEventsMapResult["graph"] = []

  for (const eventType of types) {
    const pubs = result.publishers.filter((p) => p.eventType === eventType)
    const cons = result.consumers.filter((c) => c.eventType === eventType)

    graph.push({
      eventType,
      publishers: pubs.map((p) => ({ project: p.project, file: p.file, line: p.line })),
      consumers: cons.map((c) => ({ handlerClass: c.handlerClass, project: c.project, file: c.file, line: c.line })),
    })

    // orphan-event: publish ediliyor, consumer yok
    if (pubs.length > 0 && cons.length === 0) {
      for (const p of pubs) {
        findings.push({
          severity: "Medium",
          category: CATEGORY,
          file: p.file,
          line: p.line,
          rule: "orphan-event",
          message: `Event '${eventType}' publish ediliyor ama hiçbir consumer tanımlı değil.`,
          impact:
            "Orphan event'ler ya silinmiş consumer'ın izlerini bırakır ya da consumer eklemeyi " +
            "unutulmuş bir feature'ı işaret eder. Asenkron iş akışı sessizce kopuk.",
          recommendation:
            `'${eventType}' için bir IEventHandler<${eventType}> sınıfı tanımla, veya artık ` +
            "kullanılmıyorsa publish çağrısını kaldır.",
        })
      }
    }

    // unimplemented-consumer: handler tanımlı, publish yok
    if (pubs.length === 0 && cons.length > 0) {
      for (const c of cons) {
        findings.push({
          severity: "Low",
          category: CATEGORY,
          file: c.file,
          line: c.line,
          rule: "unimplemented-consumer",
          message: `Handler '${c.handlerClass}' '${eventType}' için tanımlı ama hiçbir yerden publish edilmiyor.`,
          impact:
            "Dead consumer kod tabanını şişirir, yeni geliştiriciler kullanım yeri olduğunu sanıp " +
            "değiştirmeye çalışır.",
          recommendation:
            `'${eventType}' publish noktası başka bir servis/repo'da değilse, handler'ı sil. ` +
            "Dış servisten geliyorsa README'de açıkla.",
        })
      }
    }

    // multiple-consumers-no-explicit-fanout: aynı event'i 3+ consumer dinliyor — fan-out semantiği bilinçli mi?
    if (pubs.length > 0 && cons.length >= 3) {
      const firstPub = pubs[0]
      findings.push({
        severity: "Suggestion",
        category: CATEGORY,
        file: firstPub.file,
        line: firstPub.line,
        rule: "high-fanout-event",
        message: `'${eventType}' ${cons.length} farklı consumer tarafından dinleniyor.`,
        impact:
          "Yüksek fan-out coupling sinyali; event içeriği değişirse N farklı servis etkilenir, " +
          "release koordinasyonu zorlaşır.",
        recommendation:
          "Event payload'u immutable + versioned tut (örn: V1/V2 namespace). Consumer'ların " +
          "hangileri kritik path olduğu README/ADR'de dökümante edilsin.",
      })
    }
  }

  const filtered = findings.filter((f) => meetsMinSeverity(f.severity, minSeverity))
  const enriched = await enrichFindings({ findings: filtered, roleKey: "domain-events-analyst" })
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
    publisherCount: result.publishers.length,
    consumerCount: result.consumers.length,
    eventTypeCount: types.size,
    graph,
    summary,
    byRule,
    findings: enriched.findings,
  }
}
