import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { CONFIG } from "../../../core/config"
import type { Endpoint } from "./types"

const ROSLYN_PROJECT = path.resolve(__dirname, "../../../../../ContextMcp.Roslyn")

export function runRoslynApiContract(): Endpoint[] {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-api-contract-"))
  const outputPath = path.join(tmpDir, "endpoints.json")

  try {
    try {
      execFileSync(
        "dotnet",
        ["run", "--project", ROSLYN_PROJECT, "--", "api-contract", CONFIG.ROOT_DIR, outputPath],
        { stdio: ["ignore", "ignore", "inherit"] }
      )
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === "ENOENT") {
        process.stderr.write("[api-contract] 'dotnet' CLI bulunamadı — C# endpoint envanteri atlandı.\n")
      } else {
        process.stderr.write(`[api-contract] Roslyn subprocess hata: ${e.message}\n`)
      }
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
