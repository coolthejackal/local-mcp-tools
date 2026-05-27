// LLM enrichment yapılandırması.
// Tüm alanlar .env'den okunur. Hepsi opsiyonel — LLM_ENABLED=false varsayılan davranıştır.

export type LlmProviderName = "anthropic" | "openai"

export type LlmConfig = {
  enabled: boolean
  provider: LlmProviderName
  model: string
  apiKey: string
  maxTokens: number
  budgetUsdPerRun: number
  cacheDir: string
}

const DEFAULTS: Omit<LlmConfig, "enabled" | "apiKey"> = {
  provider: "anthropic",
  model: "claude-haiku-4-5-20251001",
  maxTokens: 1024,
  budgetUsdPerRun: 0.5,
  cacheDir: ".cache/mcp-llm",
}

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (!v) return fallback
  const s = v.trim().toLowerCase()
  return s === "true" || s === "1" || s === "yes" || s === "on"
}

function parseNumber(v: string | undefined, fallback: number): number {
  if (!v) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function parseProvider(v: string | undefined): LlmProviderName {
  if (v === "openai") return "openai"
  return "anthropic"
}

export function loadLlmConfig(): LlmConfig {
  const apiKey = (process.env.LLM_API_KEY ?? "").trim()
  const enabledFlag = parseBool(process.env.LLM_ENABLED, false)

  return {
    enabled: enabledFlag && apiKey.length > 0,
    provider: parseProvider(process.env.LLM_PROVIDER),
    model: process.env.LLM_MODEL?.trim() || DEFAULTS.model,
    apiKey,
    maxTokens: parseNumber(process.env.LLM_MAX_TOKENS, DEFAULTS.maxTokens),
    budgetUsdPerRun: parseNumber(process.env.LLM_BUDGET_USD_PER_RUN, DEFAULTS.budgetUsdPerRun),
    cacheDir: process.env.LLM_CACHE_DIR?.trim() || DEFAULTS.cacheDir,
  }
}

// Aynı süreçte tekrar tekrar process.env okumamak için tek seferlik yükleme.
let cached: LlmConfig | null = null
export function getLlmConfig(): LlmConfig {
  if (!cached) cached = loadLlmConfig()
  return cached
}

// Test ve sıcak-yeniden-yüklemeler için.
export function resetLlmConfig(): void {
  cached = null
}
