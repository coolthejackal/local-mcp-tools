import fs from "fs"
import path from "path"
import { CONFIG } from "./config"
import type { ManifestIndex, ManifestFunction } from "./manifestBuilder"

export type Annotation = {
  why?: string
  domain?: string
  risk?: string
}

// { "src/services/orderService.ts": { "applyDiscount": { why: "...", domain: "pricing" } } }
export type AnnotationMap = Record<string, Record<string, Annotation>>

export type ManifestSearchResult = {
  file: string
  function: ManifestFunction
  annotation?: Annotation
  matchType: "name" | "domain" | "keyword"
}

let cachedManifest: ManifestIndex | null = null
let cachedAnnotations: AnnotationMap | null = null
let manifestMtime: number = 0

function manifestPath() {
  return path.join(CONFIG.ROOT_DIR, "mcp-index.json")
}

function annotationPath() {
  return path.join(CONFIG.ROOT_DIR, "mcp-annotations.json")
}

export function loadManifest(): ManifestIndex | null {
  const p = manifestPath()
  if (!fs.existsSync(p)) return null

  try {
    const mtime = fs.statSync(p).mtimeMs
    if (mtime !== manifestMtime) {
      cachedManifest = JSON.parse(fs.readFileSync(p, "utf-8")) as ManifestIndex
      manifestMtime = mtime
    }
    return cachedManifest
  } catch {
    return null
  }
}

export function loadAnnotations(): AnnotationMap {
  if (cachedAnnotations) return cachedAnnotations
  const p = annotationPath()
  if (!fs.existsSync(p)) return {}
  try {
    cachedAnnotations = JSON.parse(fs.readFileSync(p, "utf-8")) as AnnotationMap
  } catch {
    cachedAnnotations = {}
  }
  return cachedAnnotations
}

export function searchManifest(query: string): ManifestSearchResult[] {
  const manifest = loadManifest()
  if (!manifest) return []

  const annotations = loadAnnotations()
  const keywords = query.toLowerCase().split(/[\s,]+/).filter(Boolean)
  const results: ManifestSearchResult[] = []

  for (const [relFile, fileData] of Object.entries(manifest.files)) {
    for (const func of fileData.functions) {
      const annotation = annotations[relFile]?.[func.name]

      const nameText    = func.name.toLowerCase()
      const domainText  = annotation?.domain?.toLowerCase() ?? ""
      const whyText     = annotation?.why?.toLowerCase() ?? ""
      const paramsText  = func.params.join(" ").toLowerCase()
      const returnsText = func.returns.toLowerCase()
      const fullText    = `${nameText} ${domainText} ${whyText} ${paramsText} ${returnsText}`

      const matched = keywords.some((kw) => fullText.includes(kw))
      if (!matched) continue

      let matchType: "name" | "domain" | "keyword" = "keyword"
      if (keywords.some((kw) => nameText.includes(kw))) {
        matchType = "name"
      } else if (domainText && keywords.some((kw) => domainText.includes(kw))) {
        matchType = "domain"
      }

      results.push({ file: relFile, function: func, annotation, matchType })
    }
  }

  // İsim eşleşmesi > domain > keyword
  results.sort((a, b) => {
    const order = { name: 0, domain: 1, keyword: 2 }
    return order[a.matchType] - order[b.matchType]
  })

  return results.slice(0, 20)
}

export function isManifestStale(): boolean {
  const manifest = loadManifest()
  if (!manifest) return true
  const ageMs = Date.now() - new Date(manifest.generated).getTime()
  return ageMs > 24 * 60 * 60 * 1000
}
