import crypto from "crypto"
import fs from "fs"
import path from "path"
import { CONFIG } from "../../../core/config"
import type { LlmInput, LlmOutput } from "./llmProvider"

// Disk-tabanlı basit prompt-response cache.
// Anahtar: SHA-256(provider + model + canonical(input))
// Dizin: CTX_ROOT/<LLM_CACHE_DIR> (CTX_ROOT dışına yazılmaz — izolasyon).

function canonicalize(input: LlmInput): string {
  // Alanları sıralı sırada serialize ederek aynı içerik için aynı hash garantisi.
  const ordered = {
    rule: input.rule,
    category: input.category,
    severity: input.severity,
    staticMessage: input.staticMessage,
    staticImpact: input.staticImpact,
    staticRecommendation: input.staticRecommendation,
    codeSnippet: input.codeSnippet,
    filePath: input.filePath,
    lineNumber: input.lineNumber,
    roleKey: input.roleKey,
  }
  return JSON.stringify(ordered)
}

function hashKey(provider: string, model: string, input: LlmInput): string {
  const payload = `${provider}|${model}|${canonicalize(input)}`
  return crypto.createHash("sha256").update(payload).digest("hex")
}

function resolveCacheDir(cacheDir: string): string {
  // Mutlak yol verilmişse CTX_ROOT içinde mi kontrol et; değilse CTX_ROOT'a yaz.
  const abs = path.isAbsolute(cacheDir)
    ? path.resolve(cacheDir)
    : path.join(CONFIG.ROOT_DIR, cacheDir)

  const root = path.resolve(CONFIG.ROOT_DIR)
  const rel = path.relative(root, abs)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    // CTX_ROOT dışı — güvenlik için reddet, CTX_ROOT içine düş.
    return path.join(root, ".cache/mcp-llm")
  }
  return abs
}

export class PromptCache {
  private readonly dir: string

  constructor(cacheDir: string) {
    this.dir = resolveCacheDir(cacheDir)
  }

  get(provider: string, model: string, input: LlmInput): LlmOutput | null {
    const key = hashKey(provider, model, input)
    const filePath = path.join(this.dir, `${key}.json`)
    if (!fs.existsSync(filePath)) return null
    try {
      const raw = fs.readFileSync(filePath, "utf8")
      return JSON.parse(raw) as LlmOutput
    } catch {
      return null
    }
  }

  set(provider: string, model: string, input: LlmInput, output: LlmOutput): void {
    const key = hashKey(provider, model, input)
    const filePath = path.join(this.dir, `${key}.json`)
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(filePath, JSON.stringify(output, null, 2), "utf8")
    } catch (err) {
      process.stderr.write(`[llm-cache] yazma hatası: ${(err as Error).message}\n`)
    }
  }
}
