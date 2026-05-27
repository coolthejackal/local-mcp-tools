import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"

// Tüm Roslyn subprocess çağrılarının tek merkezi noktası.
//
// İlk versiyon her çağrıda `dotnet run --project <proj> -- <args>` yapıyordu;
// `dotnet run` sırasında MSBuild incremental build kontrolü + JIT cold start
// ~2-3 saniye eklerdi (yedi farklı araç için ciddi gecikme).
//
// Bu helper derlenmiş DLL varsa `dotnet exec <dll> <args>` ile çalışır —
// cold start ~500 ms'e düşer. Yoksa fallback olarak `dotnet run` çalıştırır
// ve stderr'e bir kerelik uyarı yazar.

const ROSLYN_PROJECT = path.resolve(__dirname, "../../../ContextMcp.Roslyn")
const ROSLYN_DLL = path.join(ROSLYN_PROJECT, "bin", "Debug", "net9.0", "ContextMcp.Roslyn.dll")

type RunnerMode = "exec" | "run"
let cachedMode: RunnerMode | null = null
let warnedFallback = false

export type RunRoslynResult = { ok: true } | { ok: false; reason: string }

/**
 * Roslyn subprocess'i çalıştır. Önce derlenmiş DLL'i, yoksa `dotnet run` fallback.
 * Çıktı dosyaya yazılır (subprocess JSON'u stdout'a değil dosyaya basar);
 * stderr inherit edilir ki ContextMcp.Roslyn'in log'ları kullanıcıya ulaşsın.
 */
export function runRoslyn(subcommand: string, args: string[]): RunRoslynResult {
  const { command, prefix } = resolveRunner()
  try {
    execFileSync(command, [...prefix, subcommand, ...args], {
      stdio: ["ignore", "ignore", "inherit"],
    })
    return { ok: true }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === "ENOENT") {
      return { ok: false, reason: "'dotnet' CLI bulunamadı — .NET 9 SDK kurulu olmalı" }
    }
    return { ok: false, reason: e.message }
  }
}

function resolveRunner(): { command: string; prefix: string[] } {
  if (cachedMode === "exec") {
    return { command: "dotnet", prefix: ["exec", ROSLYN_DLL] }
  }
  if (cachedMode === "run") {
    return { command: "dotnet", prefix: ["run", "--project", ROSLYN_PROJECT, "--"] }
  }
  // İlk çağrı — DLL var mı?
  if (fs.existsSync(ROSLYN_DLL)) {
    cachedMode = "exec"
    return { command: "dotnet", prefix: ["exec", ROSLYN_DLL] }
  }
  cachedMode = "run"
  if (!warnedFallback) {
    warnedFallback = true
    process.stderr.write(
      "[roslyn-runner] Derlenmiş DLL bulunamadı (" + ROSLYN_DLL + "). " +
      "'dotnet run' fallback kullanılacak (yavaş). " +
      "Performans için: cd ContextMcp.Roslyn && dotnet build\n"
    )
  }
  return { command: "dotnet", prefix: ["run", "--project", ROSLYN_PROJECT, "--"] }
}

export const ROSLYN_PATHS = {
  project: ROSLYN_PROJECT,
  dll: ROSLYN_DLL,
}
