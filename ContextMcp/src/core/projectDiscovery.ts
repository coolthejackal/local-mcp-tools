import fs from "fs"
import path from "path"

export type SubProjectType = "typescript" | "dotnet"

export type SubProject = {
  type: SubProjectType
  root: string // alt projenin mutlak dizini
  name: string // CTX_ROOT'a göre ilk klasör segmenti (örn: "backend", "frontend")
}

// Keşif sırasında inilmeyecek dizinler
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".turbo",
  "bin", "obj", "docs", "MCPTools",
])

/**
 * CTX_ROOT altındaki alt projeleri keşfeder.
 *
 * - İşaretçiler: tsconfig.json → typescript, *.csproj → dotnet (.sln yok sayılır —
 *   gerçek projeler .csproj dosyalarıdır, .sln yalnızca bir gruplama dosyası).
 * - İşaretçiler CTX_ROOT'a göre ilk yol segmentine göre gruplanır; böylece
 *   monorepo'da backend/* altındaki tüm .csproj'lar tek "backend" alt projesi,
 *   frontend/ ise "frontend" alt projesi olur.
 * - İşaretçi doğrudan CTX_ROOT'ta ise ad = CTX_ROOT'un klasör adı (tek proje).
 */
export function discoverSubProjects(ctxRoot: string): SubProject[] {
  const markers: { dir: string; type: SubProjectType }[] = []

  function scan(dir: string) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    const fileNames = entries.filter((e) => e.isFile()).map((e) => e.name)
    const hasTsconfig = fileNames.includes("tsconfig.json")
    const hasCsproj = fileNames.some((f) => f.endsWith(".csproj"))

    if (hasTsconfig) {
      markers.push({ dir, type: "typescript" })
      return
    }
    if (hasCsproj) {
      markers.push({ dir, type: "dotnet" })
      return
    }

    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue
      scan(path.join(dir, e.name))
    }
  }

  scan(ctxRoot)

  // İlk yol segmentine göre grupla
  const groups = new Map<string, SubProject>()

  for (const marker of markers) {
    const rel = path.relative(ctxRoot, marker.dir)
    const segment = rel === "" ? path.basename(ctxRoot) : rel.split(path.sep)[0]
    const root = rel === "" ? ctxRoot : path.join(ctxRoot, segment)

    if (!groups.has(segment)) {
      groups.set(segment, { type: marker.type, root, name: segment })
    }
  }

  return [...groups.values()]
}
