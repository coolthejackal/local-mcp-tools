import fs from "fs"

// Postman collection.json parser — basit, defansif.
// Hedef: items'i recursive flatten, her item için method + normalize edilmiş route döndür.

export type PostmanEndpoint = {
  name: string
  method: string
  route: string         // {{var}} → * normalize edilmiş
  rawUrl: string
  source: "postman"
  folderPath: string[]  // nested folder/group adları
}

type PostmanCollection = {
  info?: { name?: string }
  item?: PostmanItem[]
}

type PostmanItem = {
  name?: string
  item?: PostmanItem[]
  request?: PostmanRequest
}

type PostmanRequest =
  | string
  | {
      method?: string
      url?: PostmanUrl
    }

type PostmanUrl =
  | string
  | {
      raw?: string
      host?: string[]
      path?: Array<string | { value?: string }>
    }

export function readPostmanCollection(path: string): PostmanCollection | null {
  try {
    const raw = fs.readFileSync(path, "utf8")
    return JSON.parse(raw) as PostmanCollection
  } catch (err) {
    process.stderr.write(`[postman-parser] okuma hatası ${path}: ${(err as Error).message}\n`)
    return null
  }
}

export function flattenEndpoints(collection: PostmanCollection): PostmanEndpoint[] {
  const out: PostmanEndpoint[] = []
  if (!collection.item) return out
  for (const item of collection.item) {
    visit(item, [], out)
  }
  return out
}

function visit(item: PostmanItem, folderPath: string[], out: PostmanEndpoint[]): void {
  if (item.item && item.item.length > 0) {
    // folder
    const sub = [...folderPath, item.name ?? ""]
    for (const child of item.item) visit(child, sub, out)
    return
  }

  if (!item.request) return
  const req = item.request
  const method = typeof req === "string" ? "GET" : (req.method ?? "GET").toUpperCase()
  const rawUrl = extractRawUrl(req)
  if (!rawUrl) return

  out.push({
    name: item.name ?? "(unnamed)",
    method,
    route: normalizeRoute(rawUrl),
    rawUrl,
    source: "postman",
    folderPath,
  })
}

function extractRawUrl(req: PostmanRequest): string {
  if (typeof req === "string") return req
  const url = req.url
  if (!url) return ""
  if (typeof url === "string") return url
  if (url.raw) return url.raw
  // Construct from host + path
  const host = (url.host ?? []).join(".")
  const path = (url.path ?? [])
    .map((p) => (typeof p === "string" ? p : p.value ?? ""))
    .join("/")
  return `${host}/${path}`
}

// Postman {{auth_url}}, {{base_url}}, {{id}} → wildcard '*' veya path segment '*'
// Ardından host kısmını at, yalnız path kalsın (kodla karşılaştırılacak olan path'tir).
export function normalizeRoute(rawUrl: string): string {
  // {{...}} segmentlerini *'a çevir
  let s = rawUrl.replace(/\{\{[^}]+\}\}/g, "*")

  // host:port veya http(s):// kısmını at
  s = s.replace(/^[a-z]+:\/\//i, "")
  const slash = s.indexOf("/")
  if (slash >= 0) s = s.substring(slash)
  else s = "/" + s

  // Query string'i at
  const q = s.indexOf("?")
  if (q >= 0) s = s.substring(0, q)

  // Sonu / ile bitiyorsa kısalt (root hariç)
  if (s.length > 1 && s.endsWith("/")) s = s.substring(0, s.length - 1)

  // Çoklu / sadeleştir
  s = s.replace(/\/+/g, "/")

  return s.toLowerCase()
}

// Kod tarafındaki route'u da normalize et — {id:guid} gibi route params'ı wildcard yap.
export function normalizeCodeRoute(route: string): string {
  let s = route
  // {paramName} ve {paramName:constraint} → *
  s = s.replace(/\{[^}]+\}/g, "*")
  if (!s.startsWith("/")) s = "/" + s
  if (s.length > 1 && s.endsWith("/")) s = s.substring(0, s.length - 1)
  s = s.replace(/\/+/g, "/")
  // Query string at
  const q = s.indexOf("?")
  if (q >= 0) s = s.substring(0, q)
  return s.toLowerCase()
}

export function routesMatch(a: string, b: string): boolean {
  // İkisi de normalize edilmiş — segment bazlı wildcard match
  const aSeg = a.split("/")
  const bSeg = b.split("/")
  if (aSeg.length !== bSeg.length) return false
  for (let i = 0; i < aSeg.length; i++) {
    if (aSeg[i] === "*" || bSeg[i] === "*") continue
    if (aSeg[i] !== bSeg[i]) return false
  }
  return true
}
