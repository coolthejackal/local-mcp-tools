import fs from "fs"
import os from "os"
import path from "path"
import { CONFIG } from "../../../core/config"
import { runRoslyn } from "../../../core/roslynRunner"
import type { Endpoint } from "./types"

export function runRoslynApiContract(): Endpoint[] {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-api-contract-"))
  const outputPath = path.join(tmpDir, "endpoints.json")

  try {
    const result = runRoslyn("api-contract", [CONFIG.ROOT_DIR, outputPath])
    if (!result.ok) {
      process.stderr.write(`[api-contract] Roslyn çağrısı başarısız: ${result.reason}\n`)
      return []
    }
    if (!fs.existsSync(outputPath)) {
      process.stderr.write("[api-contract] Roslyn çıktı dosyası üretilmedi.\n")
      return []
    }
    const raw = fs.readFileSync(outputPath, "utf8")
    const parsed = JSON.parse(raw) as Endpoint[]
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    process.stderr.write(`[api-contract] Roslyn çıktısı parse edilemedi: ${(err as Error).message}\n`)
    return []
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
