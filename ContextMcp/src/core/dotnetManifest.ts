import { execFileSync } from "child_process"
import path from "path"

// MCPTools/ContextMcp.Roslyn — Roslyn tabanlı C# manifest üreticisi
const ROSLYN_PROJECT = path.resolve(__dirname, "../../../ContextMcp.Roslyn")

/**
 * Roslyn aracını subprocess olarak çalıştırır.
 * srcRoot altındaki C# kodunu tarayıp outPath'e mcp-index.json yazar.
 */
export function runDotnetManifest(srcRoot: string, outPath: string): void {
  try {
    execFileSync(
      "dotnet",
      ["run", "--project", ROSLYN_PROJECT, "--", srcRoot, outPath],
      { stdio: ["ignore", "ignore", "inherit"] }
    )
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === "ENOENT") {
      throw new Error("'dotnet' CLI bulunamadı — .NET 9 SDK kurulu olmalı")
    }
    throw new Error(`ContextMcp.Roslyn çalışmadı (${srcRoot}): ${e.message}`)
  }
}
