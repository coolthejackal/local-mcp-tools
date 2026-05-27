import fs from "fs"
import os from "os"
import path from "path"
import { CONFIG } from "../../../core/config"
import { runRoslyn } from "../../../core/roslynRunner"
import type { Finding } from "../../shared/finding"
import type { Severity } from "../../shared/severity"
import { compareSeverityDesc, meetsMinSeverity } from "../../shared/severity"
import { enrichFindings } from "../../shared/llm/enrich"

const CATEGORY = "Architecture"

type ProjectNode = {
  name: string
  path: string
  layer: "domain" | "application" | "infrastructure" | "api" | "web" | "test" | null
  references: string[]
}

type ArchGraph = { projects: ProjectNode[] }

export type ArchAuditOptions = {
  minSeverity?: Severity
  godProjectThreshold?: number
}

export type ArchAuditResult = {
  projectCount: number
  summary: Record<Lowercase<Severity>, number>
  byRule: Record<string, number>
  layeringMap: Record<string, string | null>
  findings: Finding[]
}

function runRoslynArchGraph(): ArchGraph {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-arch-"))
  const outputPath = path.join(tmpDir, "graph.json")
  try {
    const result = runRoslyn("arch-graph", [CONFIG.ROOT_DIR, outputPath])
    if (!result.ok) {
      process.stderr.write(`[arch-audit] Roslyn çağrısı başarısız: ${result.reason}\n`)
      return { projects: [] }
    }
    if (!fs.existsSync(outputPath)) return { projects: [] }
    return JSON.parse(fs.readFileSync(outputPath, "utf8")) as ArchGraph
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// Domain → Application → Infrastructure / API; Domain ASLA Infrastructure'a referans veremez.
const FORBIDDEN_EDGES: Array<[ProjectNode["layer"], ProjectNode["layer"]]> = [
  ["domain", "infrastructure"],
  ["domain", "api"],
  ["domain", "web"],
  ["application", "api"],
  ["application", "web"],
]

function findCycles(projects: ProjectNode[]): string[][] {
  const cycles: string[][] = []
  const byName = new Map(projects.map((p) => [p.name, p]))
  const colors = new Map<string, "white" | "gray" | "black">()
  const path: string[] = []

  function dfs(name: string): void {
    colors.set(name, "gray")
    path.push(name)
    const node = byName.get(name)
    if (node) {
      for (const ref of node.references) {
        const c = colors.get(ref) ?? "white"
        if (c === "white") dfs(ref)
        else if (c === "gray") {
          // Cycle: ref'ten itibaren path slice
          const start = path.indexOf(ref)
          if (start >= 0) cycles.push([...path.slice(start), ref])
        }
      }
    }
    colors.set(name, "black")
    path.pop()
  }

  for (const p of projects) {
    if ((colors.get(p.name) ?? "white") === "white") dfs(p.name)
  }
  return cycles
}

export async function runArchAudit(options: ArchAuditOptions = {}): Promise<ArchAuditResult> {
  const minSeverity = options.minSeverity ?? "Low"
  const godThreshold = options.godProjectThreshold ?? 20
  const graph = runRoslynArchGraph()
  const byName = new Map(graph.projects.map((p) => [p.name, p]))
  const findings: Finding[] = []

  // Katman ihlali
  for (const p of graph.projects) {
    for (const ref of p.references) {
      const target = byName.get(ref)
      if (!target) continue
      if (FORBIDDEN_EDGES.some(([from, to]) => p.layer === from && target.layer === to)) {
        findings.push({
          severity: "High",
          category: CATEGORY,
          file: p.path,
          line: 1,
          rule: "layer-violation",
          message: `${p.name} (${p.layer}) → ${target.name} (${target.layer}) — katman ihlali.`,
          impact:
            "Domain katmanı dış katmana bağlanırsa Onion/Clean Architecture bozulur; " +
            "iş kuralları altyapıya bağlanır, test edilmesi ve değiştirilmesi zorlaşır.",
          recommendation:
            `Bağımlılığı tersine çevir (DI): ${p.name} içinde bir arayüz tanımla, ` +
            `${target.name} implement etsin. ${p.name} → arayüz, ${target.name} → ${p.name} olur.`,
        })
      }
    }
  }

  // Cyclic references
  const cycles = findCycles(graph.projects)
  for (const cycle of cycles) {
    const head = cycle[0]
    const proj = byName.get(head)
    findings.push({
      severity: "High",
      category: CATEGORY,
      file: proj?.path ?? "(unknown)",
      line: 1,
      rule: "cyclic-reference",
      message: `Proje referans döngüsü: ${cycle.join(" → ")}.`,
      impact:
        "Cyclic referanslar build sırasını belirsizleştirir, paketlemeyi engeller " +
        "ve modüler değiştirmeyi imkansız kılar. Yan etkiler izlenemez.",
      recommendation:
        "Döngünün en zayıf halkasını arayüz/inversion ile kır: ortak tipleri ayrı bir " +
        "proje veya namespace'e çek, döngüye giren tarafa interface enjekte et.",
    })
  }

  // God project
  const incomingCounts = new Map<string, number>()
  for (const p of graph.projects) {
    for (const ref of p.references) {
      incomingCounts.set(ref, (incomingCounts.get(ref) ?? 0) + 1)
    }
  }
  for (const [name, count] of incomingCounts.entries()) {
    if (count >= godThreshold) {
      const p = byName.get(name)
      findings.push({
        severity: "Medium",
        category: CATEGORY,
        file: p?.path ?? "(unknown)",
        line: 1,
        rule: "god-project",
        message: `Proje '${name}' ${count} farklı projeden referans alıyor.`,
        impact:
          "Çok geniş referans alanı SRP ihlali sinyalidir; değişiklik yapmak çok " +
          "sayıda projeyi etkiler, build süresini ve regresyon riskini artırır.",
        recommendation:
          "Projeyi sorumluluğa göre böl (Domain/Contracts/Models gibi alt projeler), " +
          "yalnız gerçekten ortak olan tipleri 'Shared' içinde tut.",
      })
    }
  }

  const filtered = findings.filter((f) => meetsMinSeverity(f.severity, minSeverity))
  const enriched = await enrichFindings({ findings: filtered, roleKey: "architect" })
  enriched.findings.sort((a, b) => compareSeverityDesc(a.severity, b.severity) || a.file.localeCompare(b.file))

  const summary: Record<Lowercase<Severity>, number> = {
    critical: 0, high: 0, medium: 0, low: 0, suggestion: 0,
  }
  const byRule: Record<string, number> = {}
  for (const f of enriched.findings) {
    summary[f.severity.toLowerCase() as Lowercase<Severity>]++
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1
  }
  const layeringMap: Record<string, string | null> = {}
  for (const p of graph.projects) layeringMap[p.name] = p.layer

  return {
    projectCount: graph.projects.length,
    summary,
    byRule,
    layeringMap,
    findings: enriched.findings,
  }
}
