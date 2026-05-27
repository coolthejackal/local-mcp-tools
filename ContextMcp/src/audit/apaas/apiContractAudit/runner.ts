import path from "path"
import { CONFIG } from "../../../core/config"
import type { Finding } from "../../shared/finding"
import type { Severity } from "../../shared/severity"
import { compareSeverityDesc, meetsMinSeverity } from "../../shared/severity"
import { enrichFindings } from "../../shared/llm/enrich"
import { runRoslynApiContract } from "./roslynBridge"
import {
  detectAuthIssues,
  detectMissingCancellationToken,
  detectPostmanDrift,
} from "./rules"
import { readPostmanCollection, flattenEndpoints } from "../../shared/postmanParser"
import type { Endpoint } from "./types"

export type ApiContractOptions = {
  compareWithPostman?: boolean
  postmanPath?: string  // CTX_ROOT'a göre relative veya mutlak
  minSeverity?: Severity
}

export type ApiContractResult = {
  endpointsExtracted: number
  postmanEndpoints: number
  summary: Record<Lowercase<Severity>, number>
  byRule: Record<string, number>
  findings: Finding[]
  endpoints: Endpoint[]
}

export async function runApiContractAudit(options: ApiContractOptions = {}): Promise<ApiContractResult> {
  const minSeverity = options.minSeverity ?? "Low"

  const endpoints = runRoslynApiContract()

  const findings: Finding[] = [
    ...detectAuthIssues(endpoints),
    ...detectMissingCancellationToken(endpoints),
  ]

  let postmanCount = 0
  if (options.compareWithPostman !== false) {
    const pmPath = resolvePostmanPath(options.postmanPath)
    if (pmPath) {
      const collection = readPostmanCollection(pmPath)
      if (collection) {
        const postmanEndpoints = flattenEndpoints(collection)
        postmanCount = postmanEndpoints.length
        const drift = detectPostmanDrift(endpoints, postmanEndpoints)
        findings.push(...drift.missingInPostman, ...drift.orphanInPostman, ...drift.routeMismatch)
      }
    } else {
      process.stderr.write("[api-contract] Postman koleksiyonu bulunamadı — drift kontrolü atlandı.\n")
    }
  }

  const filtered = findings.filter((f) => meetsMinSeverity(f.severity, minSeverity))

  // Opsiyonel LLM enrichment (varsayılan: kapalı, no-op)
  const enriched = await enrichFindings({
    findings: filtered,
    roleKey: "api-contract-auditor",
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
    endpointsExtracted: endpoints.length,
    postmanEndpoints: postmanCount,
    summary,
    byRule,
    findings: enriched.findings,
    endpoints,
  }
}

function resolvePostmanPath(userPath: string | undefined): string | null {
  const fs = require("fs") as typeof import("fs")
  const candidates: string[] = []

  if (userPath) {
    candidates.push(path.isAbsolute(userPath) ? userPath : path.join(CONFIG.ROOT_DIR, userPath))
  }
  // Defaultları dene
  candidates.push(path.join(CONFIG.ROOT_DIR, "docs/postman/OneFlow.postman_collection.json"))
  candidates.push(path.join(CONFIG.ROOT_DIR, "docs/postman"))

  for (const c of candidates) {
    if (!fs.existsSync(c)) continue
    const stat = fs.statSync(c)
    if (stat.isFile()) return c
    if (stat.isDirectory()) {
      const items = fs.readdirSync(c)
      const json = items.find((f: string) => f.endsWith(".postman_collection.json"))
      if (json) return path.join(c, json)
    }
  }
  return null
}
