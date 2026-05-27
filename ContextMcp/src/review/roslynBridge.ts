import fs from "fs"
import os from "os"
import path from "path"
import { runRoslyn } from "../core/roslynRunner"
import type { Finding } from "./finding"
import type { Category } from "./severity"

export function isCsFile(file: string): boolean {
  return file.toLowerCase().endsWith(".cs")
}

/**
 * Verilen C# dosyalarını ContextMcp.Roslyn subprocess'i ile review eder.
 * .NET SDK yoksa veya çağrı başarısızsa boş dizi döner ve stderr'e uyarı yazar
 * (kısmi başarı: TS bulguları yine de işlenir).
 */
export function runRoslynReview(csFiles: string[], categories?: Category[]): Finding[] {
  if (csFiles.length === 0) return []

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-review-"))
  const fileListPath = path.join(tmpDir, "files.txt")
  const outputPath = path.join(tmpDir, "findings.json")

  try {
    fs.writeFileSync(fileListPath, csFiles.join("\n"), "utf8")

    const args = [fileListPath, outputPath]
    if (categories?.length) args.push(`--categories=${categories.join(",")}`)

    const result = runRoslyn("review", args)
    if (!result.ok) {
      process.stderr.write(`[review] Roslyn çağrısı başarısız: ${result.reason}\n`)
      return []
    }

    if (!fs.existsSync(outputPath)) {
      process.stderr.write("[review] Roslyn çıktı dosyası üretilmedi.\n")
      return []
    }

    const raw = fs.readFileSync(outputPath, "utf8")
    const parsed = JSON.parse(raw) as Finding[]
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    process.stderr.write(`[review] Roslyn çıktısı parse edilemedi: ${(err as Error).message}\n`)
    return []
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }
}
