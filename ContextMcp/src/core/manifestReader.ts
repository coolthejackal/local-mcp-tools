import fs from "fs"
import path from "path"
import { CONFIG } from "./config"
import type { ManifestIndex, ManifestFunction } from "./manifestBuilder"

export type Annotation = {
  why?: string
  domain?: string
  risk?: string
}

// { "src/services/orderService.ts": { "applyDiscount": { why, domain, risk } } }
export type AnnotationMap = Record<string, Record<string, Annotation>>

export type ManifestSearchResult = {
  project: string                 // docs/monorepo altındaki alt proje adı
  file: string                    // alt proje köküne göre göreli yol
  absPath: string                 // çözümlenmiş mutlak yol
  function: ManifestFunction
  annotation?: Annotation
  matchType: "name" | "domain" | "keyword"
}

type LoadedManifest = {
  project: string
  manifest: ManifestIndex
  annotations: AnnotationMap
}

let cache: LoadedManifest[] | null = null
let cacheKey = ""

function monorepoDir(): string {
  return path.join(CONFIG.ROOT_DIR, "docs", "monorepo")
}

/**
 * docs/monorepo/<alt-proje>/mcp-index.json dosyalarının tümünü okur.
 * mtime tabanlı cache — dosya değişmediyse yeniden parse etmez.
 */
export function loadAllManifests(): LoadedManifest[] {
  const dir = monorepoDir()
  if (!fs.existsSync(dir)) return []

  const subDirs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)

  // cache anahtarı: alt proje + manifest mtime
  const key = subDirs
    .map((s) => {
      try {
        return `${s}:${fs.statSync(path.join(dir, s, "mcp-index.json")).mtimeMs}`
      } catch {
        return `${s}:0`
      }
    })
    .join("|")

  if (cache && cacheKey === key) return cache

  const loaded: LoadedManifest[] = []
  for (const sub of subDirs) {
    const idxPath = path.join(dir, sub, "mcp-index.json")
    if (!fs.existsSync(idxPath)) continue
    try {
      const manifest = JSON.parse(fs.readFileSync(idxPath, "utf-8")) as ManifestIndex
      let annotations: AnnotationMap = {}
      const annPath = path.join(dir, sub, "mcp-annotations.json")
      if (fs.existsSync(annPath)) {
        try {
          annotations = JSON.parse(fs.readFileSync(annPath, "utf-8")) as AnnotationMap
        } catch {
          // bozuk annotation dosyası yok sayılır
        }
      }
      loaded.push({ project: sub, manifest, annotations })
    } catch {
      // bozuk manifest atlanır
    }
  }

  cache = loaded
  cacheKey = key
  return loaded
}

export function listProjects(): string[] {
  return loadAllManifests().map((m) => m.project)
}

/**
 * Tüm alt projelerde (veya projectFilter verilirse tek alt projede) arama yapar.
 * Her sonuç hangi alt projeden geldiği etiketiyle döner.
 */
export function searchManifest(query: string, projectFilter?: string): ManifestSearchResult[] {
  const all = loadAllManifests()
  const keywords = query.toLowerCase().split(/[\s,]+/).filter(Boolean)
  const results: ManifestSearchResult[] = []

  for (const { project, manifest, annotations } of all) {
    if (projectFilter && project !== projectFilter) continue

    for (const [relFile, fileData] of Object.entries(manifest.files)) {
      for (const func of fileData.functions) {
        const annotation = annotations[relFile]?.[func.name]

        const nameText    = func.name.toLowerCase()
        const classText   = (func.class ?? "").toLowerCase()
        const attrText    = (func.attributes ?? []).join(" ").toLowerCase()
        const domainText  = annotation?.domain?.toLowerCase() ?? ""
        const whyText     = annotation?.why?.toLowerCase() ?? ""
        const paramsText  = func.params.join(" ").toLowerCase()
        const returnsText = func.returns.toLowerCase()
        const fullText =
          `${nameText} ${classText} ${attrText} ${domainText} ${whyText} ${paramsText} ${returnsText}`

        if (!keywords.some((kw) => fullText.includes(kw))) continue

        let matchType: "name" | "domain" | "keyword" = "keyword"
        if (keywords.some((kw) => nameText.includes(kw) || classText.includes(kw))) {
          matchType = "name"
        } else if (domainText && keywords.some((kw) => domainText.includes(kw))) {
          matchType = "domain"
        }

        results.push({
          project,
          file: relFile,
          absPath: path.join(manifest.root, relFile.replace(/\//g, path.sep)),
          function: func,
          annotation,
          matchType,
        })
      }
    }
  }

  // İsim eşleşmesi > domain > keyword
  results.sort((a, b) => {
    const order = { name: 0, domain: 1, keyword: 2 }
    return order[a.matchType] - order[b.matchType]
  })

  return results.slice(0, 25)
}

/** Tüm alt projelerin annotation'larını birleştirir. */
export function loadAnnotations(): AnnotationMap {
  const merged: AnnotationMap = {}
  for (const { annotations } of loadAllManifests()) {
    Object.assign(merged, annotations)
  }
  return merged
}

/** Herhangi bir alt proje manifest'i 24 saatten eskiyse stale sayılır. */
export function isManifestStale(): boolean {
  const all = loadAllManifests()
  if (all.length === 0) return true
  return all.some(({ manifest }) => {
    const ageMs = Date.now() - new Date(manifest.generated).getTime()
    return ageMs > 24 * 60 * 60 * 1000
  })
}
