import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import type { Finding } from "./finding"
import type { Category } from "./severity"

const ROSLYN_PROJECT = path.resolve(__dirname, "../../../ContextMcp.Roslyn")

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

    const cliArgs = [
      "run",
      "--project",
      ROSLYN_PROJECT,
      "--",
      "review",
      fileListPath,
      outputPath,
    ]
    if (categories?.length) {
      cliArgs.push(`--categories=${categories.join(",")}`)
    }

    try {
      execFileSync("dotnet", cliArgs, { stdio: ["ignore", "ignore", "inherit"] })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === "ENOENT") {
        process.stderr.write("[review] 'dotnet' CLI bulunamadı — C# review atlandı.\n")
      } else {
        process.stderr.write(`[review] Roslyn subprocess hata: ${e.message}\n`)
      }
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
