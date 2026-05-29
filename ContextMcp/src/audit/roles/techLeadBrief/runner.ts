/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs"
import path from "path"
import { CONFIG } from "../../../core/config"
import type { Finding } from "../../shared/finding"
import type { Severity } from "../../shared/severity"
import { runSecurityAudit } from "../securityAudit/runner"
import { runDatabaseAudit } from "../databaseAudit/runner"
import { runQaAudit } from "../qaAudit/runner"
import { runArchAudit } from "../archAudit/runner"
import { runDevOpsAudit } from "../devopsAudit/runner"
import { runObservabilityAudit } from "../observabilityAudit/runner"
import { runSupportAudit } from "../supportAudit/runner"
import { runDocsAudit } from "../docsAudit/runner"
import { runA11yAudit } from "../a11yAudit/runner"
import { runPmStatus } from "../pmStatus/runner"

export type TechLeadBriefOptions = {
  includeDocs?: boolean
  includeA11y?: boolean
  writeMarkdown?: string | null  // CTX_ROOT'a göre relative — örn: "docs/tech-lead-brief.md"
}

type ToolSummary = {
  total: number
  bySeverity: Record<Lowercase<Severity>, number>
  byRule: Record<string, number>
  topFindings: Finding[]
  durationMs: number
  error?: string
}

export type TechLeadBriefResult = {
  generatedAt: string
  previousRunAt: string | null
  durationSec: number
  totalFindings: number
  trendDelta: number | null
  byTool: Record<string, ToolSummary>
  topFiles: Array<{ file: string; count: number }>
  pmStatus: { branch: string; commits30d: number; todos: number; deadBranches: number }
  markdown: string
  markdownWrittenTo?: string
}

const SNAPSHOT_REL = ".cache/mcp-tech-lead/snapshot.json"
const CACHE_DIR = ".cache/mcp-tech-lead"

function ensureCacheDir(): string {
  const dir = path.join(CONFIG.ROOT_DIR, CACHE_DIR)
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  return dir
}

function readSnapshot(): { generatedAt: string; byTool: Record<string, { total: number; byRule: Record<string, number> }> } | null {
  const file = path.join(CONFIG.ROOT_DIR, SNAPSHOT_REL)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    process.stderr.write(`[tech-lead-brief] snapshot bozuk: ${file} — trend hesabı atlanıyor.\n`)
    return null
  }
}

function writeSnapshot(byTool: Record<string, ToolSummary>): void {
  ensureCacheDir()
  const minimal = Object.fromEntries(
    Object.entries(byTool).map(([k, v]) => [k, { total: v.total, byRule: v.byRule }])
  )
  const file = path.join(CONFIG.ROOT_DIR, SNAPSHOT_REL)
  try {
    fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), byTool: minimal }, null, 2))
  } catch (err) {
    process.stderr.write(`[tech-lead-brief] snapshot yazılamadı: ${(err as Error).message}\n`)
  }
}

async function runTool(
  name: string,
  invoker: () => Promise<{ findings: Finding[] }>
): Promise<ToolSummary> {
  const start = Date.now()
  const empty: ToolSummary = {
    total: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0, suggestion: 0 },
    byRule: {},
    topFindings: [],
    durationMs: 0,
  }
  try {
    const result = await invoker()
    const findings = result.findings ?? []
    const out: ToolSummary = {
      ...empty,
      total: findings.length,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0, suggestion: 0 },
      byRule: {},
      topFindings: findings.slice(0, 3),
      durationMs: Date.now() - start,
    }
    for (const f of findings) {
      out.bySeverity[f.severity.toLowerCase() as Lowercase<Severity>]++
      out.byRule[f.rule] = (out.byRule[f.rule] ?? 0) + 1
    }
    return out
  } catch (err) {
    process.stderr.write(`[tech-lead-brief] ${name} hata: ${(err as Error).message}\n`)
    return { ...empty, error: (err as Error).message, durationMs: Date.now() - start }
  }
}

function buildMarkdown(result: Omit<TechLeadBriefResult, "markdown" | "markdownWrittenTo">): string {
  const dateStr = result.generatedAt.substring(0, 10)
  const trendStr = result.trendDelta === null
    ? "(no previous run)"
    : result.trendDelta > 0
      ? `+${result.trendDelta} (worse)`
      : result.trendDelta < 0
        ? `${result.trendDelta} (better)`
        : "= unchanged"

  const lines: string[] = []
  lines.push(`# Tech Lead Brief — ${dateStr}`)
  lines.push("")
  lines.push(`Duration: ${result.durationSec.toFixed(1)}s · Total: ${result.totalFindings} findings · Trend: ${trendStr}`)
  lines.push("")

  // PM Status
  lines.push("## Project Pulse (last 30d)")
  lines.push(`- Branch: \`${result.pmStatus.branch}\``)
  lines.push(`- Commits: ${result.pmStatus.commits30d}`)
  lines.push(`- Open TODOs: ${result.pmStatus.todos}`)
  lines.push(`- Dead branches: ${result.pmStatus.deadBranches}`)
  lines.push("")

  // By tool table
  lines.push("## By Tool")
  lines.push("| Tool | Total | Critical | High | Medium | Duration |")
  lines.push("|------|------:|---------:|-----:|-------:|---------:|")
  for (const [tool, sum] of Object.entries(result.byTool)) {
    const s = sum.bySeverity
    const errMark = sum.error ? " ⚠" : ""
    lines.push(`| ${tool}${errMark} | ${sum.total} | ${s.critical} | ${s.high} | ${s.medium} | ${(sum.durationMs / 1000).toFixed(2)}s |`)
  }
  lines.push("")

  // Hotspot files
  if (result.topFiles.length > 0) {
    lines.push("## Hotspot Files (most findings)")
    lines.push("| File | Findings |")
    lines.push("|------|---------:|")
    for (const tf of result.topFiles.slice(0, 10)) {
      const short = tf.file.length > 80 ? "…" + tf.file.substring(tf.file.length - 80) : tf.file
      lines.push(`| \`${short}\` | ${tf.count} |`)
    }
    lines.push("")
  }

  // Top rules across all tools
  const allRules: Record<string, { tool: string; count: number }> = {}
  for (const [tool, sum] of Object.entries(result.byTool)) {
    for (const [rule, count] of Object.entries(sum.byRule)) {
      const key = `${tool}/${rule}`
      allRules[key] = { tool, count: (allRules[key]?.count ?? 0) + count }
    }
  }
  const topRules = Object.entries(allRules).sort((a, b) => b[1].count - a[1].count).slice(0, 8)
  if (topRules.length > 0) {
    lines.push("## Most Active Rules")
    for (const [key, info] of topRules) {
      const [, rule] = key.split("/")
      lines.push(`- \`${info.tool}/${rule}\` — ${info.count}`)
    }
    lines.push("")
  }

  // High-severity headlines (top 5 high/critical findings)
  const highCriticalFlat: Array<{ tool: string; finding: Finding }> = []
  for (const [tool, sum] of Object.entries(result.byTool)) {
    for (const f of sum.topFindings) {
      if (f.severity === "Critical" || f.severity === "High") {
        highCriticalFlat.push({ tool, finding: f })
      }
    }
  }
  if (highCriticalFlat.length > 0) {
    lines.push("## High-Priority Findings")
    for (const { tool, finding: f } of highCriticalFlat.slice(0, 5)) {
      const fileShort = path.basename(f.file)
      lines.push(`- **[${f.severity}]** \`${tool}/${f.rule}\` — ${fileShort}:${f.line}`)
      lines.push(`  > ${f.message}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

export async function runTechLeadBrief(
  options: TechLeadBriefOptions = {}
): Promise<TechLeadBriefResult> {
  const start = Date.now()
  const generatedAt = new Date().toISOString()
  const previous = readSnapshot()

  const byTool: Record<string, ToolSummary> = {}

  byTool["security_audit"] = await runTool("security_audit", () =>
    runSecurityAudit({ minSeverity: "Low", skipDependencyScan: true })
  )
  byTool["database_audit"] = await runTool("database_audit", () =>
    runDatabaseAudit({ minSeverity: "Low" })
  )
  byTool["observability_audit"] = await runTool("observability_audit", () =>
    runObservabilityAudit({ minSeverity: "Low" })
  )
  byTool["qa_audit"] = await runTool("qa_audit", () =>
    runQaAudit({ minSeverity: "Low" })
  )
  byTool["arch_audit"] = await runTool("arch_audit", () =>
    runArchAudit({ minSeverity: "Low" })
  )
  byTool["devops_audit"] = await runTool("devops_audit", () =>
    runDevOpsAudit({ minSeverity: "Low" })
  )
  byTool["support_audit"] = await runTool("support_audit", () =>
    runSupportAudit({ minSeverity: "Low" })
  )
  if (options.includeDocs) {
    byTool["docs_audit"] = await runTool("docs_audit", () =>
      runDocsAudit({ minSeverity: "Low" })
    )
  }
  if (options.includeA11y) {
    byTool["a11y_audit"] = await runTool("a11y_audit", () =>
      runA11yAudit({ minSeverity: "Low" })
    )
  }

  // PM Status (always)
  const pm = runPmStatus({ sinceDays: 30 })
  const pmStatus = {
    branch: pm.branch,
    commits30d: pm.commitActivity.totalCommits,
    todos: pm.todoInventory.total,
    deadBranches: pm.deadBranches.length,
  }

  // Aggregate
  const totalFindings = Object.values(byTool).reduce((acc, s) => acc + s.total, 0)
  const prevTotal = previous
    ? Object.values(previous.byTool).reduce((acc: number, s: any) => acc + (s.total ?? 0), 0)
    : null
  const trendDelta = prevTotal === null ? null : totalFindings - prevTotal

  // Top files across all tools (file → count)
  const fileCounts: Record<string, number> = {}
  for (const sum of Object.values(byTool)) {
    // topFindings'ten yapamayız; ama her tool finding'lerini snapshot için sayalım
    // Şimdilik topFindings içinden çıkar (tam liste sağlanmıyor — meta-tool sınırı)
    for (const f of sum.topFindings) {
      fileCounts[f.file] = (fileCounts[f.file] ?? 0) + 1
    }
  }
  const topFiles = Object.entries(fileCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, count]) => ({ file, count }))

  const partial: Omit<TechLeadBriefResult, "markdown" | "markdownWrittenTo"> = {
    generatedAt,
    previousRunAt: previous?.generatedAt ?? null,
    durationSec: (Date.now() - start) / 1000,
    totalFindings,
    trendDelta,
    byTool,
    topFiles,
    pmStatus,
  }
  const markdown = buildMarkdown(partial)

  // Snapshot kaydet
  writeSnapshot(byTool)

  // Markdown yaz (opsiyonel)
  let markdownWrittenTo: string | undefined
  if (options.writeMarkdown) {
    const target = path.isAbsolute(options.writeMarkdown)
      ? options.writeMarkdown
      : path.join(CONFIG.ROOT_DIR, options.writeMarkdown)
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, markdown, "utf8")
      markdownWrittenTo = target
    } catch (err) {
      process.stderr.write(`[tech-lead-brief] markdown yazılamadı: ${(err as Error).message}\n`)
    }
  }

  return { ...partial, markdown, markdownWrittenTo }
}
