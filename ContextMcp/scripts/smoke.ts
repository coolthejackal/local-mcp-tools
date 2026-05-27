/* eslint-disable @typescript-eslint/no-explicit-any */
// Smoke test — her MCP aracını sırayla çalıştırır, özet bilgisini yazdırır.
// Bulgu detaylarını basmaz; sadece "açılıyor mu, JSON dönüyor mu" doğrulanır.
//
// Çalıştırma: npx ts-node scripts/smoke.ts

import { buildContext, getContext } from "../src/core/indexer"
import { initTS } from "../src/ts/tsIncremental"
import { reviewCode } from "../src/review/reviewEngine"
import { runApiContractAudit } from "../src/audit/apaas/apiContractAudit/runner"
import { runFrontendCompliance } from "../src/audit/apaas/frontendCompliance/runner"
import { runTenantIsolationAudit } from "../src/audit/apaas/tenantIsolation/runner"
import { runArchAudit } from "../src/audit/roles/archAudit/runner"
import { runQaAudit } from "../src/audit/roles/qaAudit/runner"
import { runDevOpsAudit } from "../src/audit/roles/devopsAudit/runner"
import { runSecurityAudit } from "../src/audit/roles/securityAudit/runner"
import { runDocsAudit } from "../src/audit/roles/docsAudit/runner"
import { runPmStatus } from "../src/audit/roles/pmStatus/runner"
import { runDomainEventsMap } from "../src/audit/apaas/domainEventsMap/runner"
import { CONFIG } from "../src/core/config"

function ms(start: number): string {
  return `${((Date.now() - start) / 1000).toFixed(2)}s`
}

async function step<T>(name: string, fn: () => Promise<T> | T): Promise<{ ok: boolean; durationMs: number; result?: T; error?: string }> {
  const start = Date.now()
  process.stdout.write(`\n── ${name} ──\n`)
  try {
    const result = await fn()
    const dur = Date.now() - start
    process.stdout.write(`✓ ${name} (${ms(start)})\n`)
    return { ok: true, durationMs: dur, result }
  } catch (err) {
    const dur = Date.now() - start
    process.stdout.write(`✗ ${name} (${ms(start)}): ${(err as Error).message}\n`)
    return { ok: false, durationMs: dur, error: (err as Error).message }
  }
}

async function main() {
  process.stdout.write(`CTX_ROOT: ${CONFIG.ROOT_DIR}\n`)

  // Önce build_context (smart_context bağımlısı)
  const build = await step("build_context", () => {
    buildContext()
    return Object.keys(getContext()).length
  })
  process.stdout.write(`  indexed files: ${build.result}\n`)

  // initTS gerekli — review/qa/frontend için TS Compiler API kullanımı
  const ts = await step("initTS (TS Compiler API)", () => {
    initTS()
    const { getProgram } = require("../src/ts/tsIncremental") as typeof import("../src/ts/tsIncremental")
    const program = getProgram()
    const sourceFiles = program.getSourceFiles().filter((sf: any) => !sf.isDeclarationFile)
    return { sourceFileCount: sourceFiles.length }
  })
  if (ts.result) process.stdout.write(`  TS source files: ${(ts.result as any).sourceFileCount}\n`)

  // review — query-driven, basit bir sorgu
  const review = await step("review (query='controller')", () =>
    reviewCode("controller", { minSeverity: "Medium" })
  )
  if (review.result) {
    const r = review.result as any
    process.stdout.write(`  filesReviewed: ${r.filesReviewed}, findings: ${r.findings.length}\n`)
    process.stdout.write(`  summary: ${JSON.stringify(r.summary)}\n`)
  }

  const apiContract = await step("api_contract_audit", () =>
    runApiContractAudit({ minSeverity: "Medium" })
  )
  if (apiContract.result) {
    const r = apiContract.result as any
    process.stdout.write(`  endpoints: ${r.endpointsExtracted}, postman: ${r.postmanEndpoints}, findings: ${r.findings.length}\n`)
    process.stdout.write(`  byRule: ${JSON.stringify(r.byRule)}\n`)
  }

  const frontend = await step("frontend_compliance (query='axios')", () =>
    runFrontendCompliance({ query: "axios", minSeverity: "Medium" })
  )
  if (frontend.result) {
    const r = frontend.result as any
    process.stdout.write(`  filesReviewed: ${r.filesReviewed}, findings: ${r.findings.length}\n`)
    process.stdout.write(`  byRule: ${JSON.stringify(r.byRule)}\n`)
  }

  const tenant = await step("tenant_isolation_audit", () =>
    runTenantIsolationAudit({ minSeverity: "Medium" })
  )
  if (tenant.result) {
    const r = tenant.result as any
    process.stdout.write(`  entities: ${r.entitiesAnalyzed}, findings: ${r.findings.length}\n`)
    process.stdout.write(`  byRule: ${JSON.stringify(r.byRule)}\n`)
  }

  const arch = await step("arch_audit", () =>
    runArchAudit({ minSeverity: "Medium" })
  )
  if (arch.result) {
    const r = arch.result as any
    process.stdout.write(`  projects: ${r.projectCount}, findings: ${r.findings.length}\n`)
    process.stdout.write(`  byRule: ${JSON.stringify(r.byRule)}\n`)
  }

  const qa = await step("qa_audit", () =>
    runQaAudit({ minSeverity: "Medium" })
  )
  if (qa.result) {
    const r = qa.result as any
    process.stdout.write(`  prod fns: ${r.productionFnCount}, tests: ${r.testCount}, findings: ${r.findings.length}\n`)
    process.stdout.write(`  byRule: ${JSON.stringify(r.byRule)}\n`)
  }

  const devops = await step("devops_audit", () =>
    runDevOpsAudit({ minSeverity: "Medium" })
  )
  if (devops.result) {
    const r = devops.result as any
    process.stdout.write(`  files: ${r.filesScanned}, findings: ${r.findings.length}\n`)
    process.stdout.write(`  byRule: ${JSON.stringify(r.byRule)}\n`)
  }

  // skipDependencyScan: true — smoke test'i hızlı tutmak için npm audit + dotnet list package atla.
  // Gerçek kullanımda false bırakılır.
  const security = await step("security_audit (deps skipped for speed)", () =>
    runSecurityAudit({ minSeverity: "Medium", skipDependencyScan: true })
  )
  if (security.result) {
    const r = security.result as any
    process.stdout.write(`  configFiles: ${r.scanned.configFiles}, findings: ${r.findings.length}\n`)
    process.stdout.write(`  byRule: ${JSON.stringify(r.byRule)}\n`)
  }

  const docs = await step("docs_audit", () =>
    runDocsAudit({ minSeverity: "Low" })
  )
  if (docs.result) {
    const r = docs.result as any
    process.stdout.write(`  readme: ${r.scanned.readmeFiles}, claude.md: ${r.scanned.claudeMdFiles}, ` +
      `docs.md: ${r.scanned.docsMdFiles}, adr: ${r.scanned.adrFiles}, findings: ${r.findings.length}\n`)
    process.stdout.write(`  byRule: ${JSON.stringify(r.byRule)}\n`)
  }

  const pm = await step("pm_status", () =>
    runPmStatus({ sinceDays: 30 })
  )
  if (pm.result) {
    const r = pm.result as any
    process.stdout.write(`  branch: ${r.branch}, commits: ${r.commitActivity.totalCommits}, deadBranches: ${r.deadBranches.length}, TODOs: ${r.todoInventory.total}\n`)
  }

  const events = await step("domain_events_map", () =>
    runDomainEventsMap({ minSeverity: "Medium" })
  )
  if (events.result) {
    const r = events.result as any
    process.stdout.write(`  publishers: ${r.publisherCount}, consumers: ${r.consumerCount}, eventTypes: ${r.eventTypeCount}, findings: ${r.findings.length}\n`)
    process.stdout.write(`  byRule: ${JSON.stringify(r.byRule)}\n`)
  }

  // Özet
  process.stdout.write("\n=== Özet ===\n")
  const all = [build, review, apiContract, frontend, tenant, arch, qa, devops, security, docs, pm, events]
  const labels = ["build_context", "review", "api_contract_audit", "frontend_compliance",
    "tenant_isolation_audit", "arch_audit", "qa_audit", "devops_audit", "security_audit",
    "docs_audit", "pm_status", "domain_events_map"]
  for (let i = 0; i < all.length; i++) {
    const r = all[i]
    process.stdout.write(`  ${r.ok ? "✓" : "✗"} ${labels[i].padEnd(28)} ${(r.durationMs / 1000).toFixed(2).padStart(6)}s\n`)
  }
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${(err as Error).stack ?? err}\n`)
  process.exit(1)
})
