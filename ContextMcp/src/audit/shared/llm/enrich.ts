import fs from "fs"
import { getLlmConfig } from "./llmConfig"
import type { LlmInput, LlmOptions, LlmProvider } from "./llmProvider"
import { PromptCache } from "./cache"
import { systemPromptFor, type RoleKey } from "./promptTemplates"
import type { Finding } from "../finding"

// Finding[] → enriched Finding[].
// LLM kapalıysa (default) input olduğu gibi döner — no-op.
// LLM açıksa: provider'ı lazy-load eder, cache'i kullanır, bütçeyi izler.

export type EnrichRequest = {
  findings: Finding[]
  roleKey: RoleKey
  // Kod snippet'i okuma helper'ı; çağıran sağlar (TS Compiler API veya fs).
  readSnippet?: (file: string, line: number) => string
}

export type EnrichStats = {
  enabled: boolean
  attempted: number
  enriched: number
  cacheHits: number
  budgetSkipped: number
  errors: number
  estimatedCostUsd: number
}

let providerPromise: Promise<LlmProvider | null> | null = null

async function loadProvider(): Promise<LlmProvider | null> {
  const cfg = getLlmConfig()
  if (!cfg.enabled) return null

  try {
    if (cfg.provider === "anthropic") {
      // Lazy require — @anthropic-ai/sdk optionalDependencies içinde.
      const mod = await import("./anthropicProvider")
      return new mod.AnthropicProvider(cfg.apiKey)
    }
    process.stderr.write(`[llm-enrich] desteklenmeyen provider: ${cfg.provider}\n`)
    return null
  } catch (err) {
    process.stderr.write(`[llm-enrich] provider yüklenemedi: ${(err as Error).message}\n`)
    return null
  }
}

function defaultReadSnippet(file: string, line: number, contextLines = 3): string {
  try {
    const text = fs.readFileSync(file, "utf8")
    const lines = text.split(/\r?\n/)
    const start = Math.max(0, line - 1 - contextLines)
    const end = Math.min(lines.length, line + contextLines)
    return lines.slice(start, end).join("\n")
  } catch {
    return ""
  }
}

export async function enrichFindings(req: EnrichRequest): Promise<{ findings: Finding[]; stats: EnrichStats }> {
  const cfg = getLlmConfig()
  const stats: EnrichStats = {
    enabled: cfg.enabled,
    attempted: 0,
    enriched: 0,
    cacheHits: 0,
    budgetSkipped: 0,
    errors: 0,
    estimatedCostUsd: 0,
  }

  if (!cfg.enabled) {
    return { findings: req.findings, stats }
  }

  if (!providerPromise) providerPromise = loadProvider()
  const provider = await providerPromise
  if (!provider) return { findings: req.findings, stats }

  const cache = new PromptCache(cfg.cacheDir)
  const readSnippet = req.readSnippet ?? defaultReadSnippet
  const opts: LlmOptions = { model: cfg.model, maxTokens: cfg.maxTokens }
  const enriched: Finding[] = []

  for (const f of req.findings) {
    stats.attempted++

    if (stats.estimatedCostUsd >= cfg.budgetUsdPerRun) {
      stats.budgetSkipped++
      enriched.push(f)
      continue
    }

    const input: LlmInput = {
      rule: f.rule,
      category: f.category,
      severity: f.severity,
      staticMessage: f.message,
      staticImpact: f.impact,
      staticRecommendation: f.recommendation,
      codeSnippet: readSnippet(f.file, f.line),
      filePath: f.file,
      lineNumber: f.line,
      roleKey: req.roleKey,
    }

    const cached = cache.get(provider.name(), cfg.model, input)
    if (cached) {
      stats.cacheHits++
      stats.enriched++
      enriched.push({ ...f, enrichment: cached.enrichment })
      continue
    }

    try {
      // systemPromptFor sadece provider tarafında kullanılır; provider abstraction
      // promptu kendisi inşa eder. Burada erken-çağrı için referans alıyoruz.
      void systemPromptFor(req.roleKey)

      const output = await provider.enrich(input, opts)
      cache.set(provider.name(), cfg.model, input, output)
      stats.enriched++
      stats.estimatedCostUsd += output.estimatedCostUsd
      enriched.push({ ...f, enrichment: output.enrichment })
    } catch (err) {
      stats.errors++
      process.stderr.write(`[llm-enrich] '${f.rule}' enrichment atlandı: ${(err as Error).message}\n`)
      enriched.push(f)
    }
  }

  return { findings: enriched, stats }
}
