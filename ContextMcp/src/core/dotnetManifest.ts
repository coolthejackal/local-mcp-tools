import { runRoslyn } from "./roslynRunner"

/**
 * Roslyn aracını subprocess olarak çalıştırır.
 * srcRoot altındaki C# kodunu tarayıp outPath'e mcp-index.json yazar.
 *
 * (Eski API: positional args. Yeni API: subcommand "manifest".
 * Program.cs geriye uyumluluk için subcommand'sız çağrıyı da kabul ediyor,
 * ama yeni subprocess wrapper'ı her zaman explicit subcommand gönderir.)
 */
export function runDotnetManifest(srcRoot: string, outPath: string): void {
  const result = runRoslyn("manifest", [srcRoot, outPath])
  if (!result.ok) {
    throw new Error(`ContextMcp.Roslyn manifest çalışmadı (${srcRoot}): ${result.reason}`)
  }
}
