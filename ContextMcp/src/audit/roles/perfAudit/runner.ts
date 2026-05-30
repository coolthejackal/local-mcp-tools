import fs from "fs"
import path from "path"
import { CONFIG } from "../../../core/config"
import type { Finding } from "../../shared/finding"
import type { Severity } from "../../shared/severity"
import { compareSeverityDesc, meetsMinSeverity } from "../../shared/severity"
import { enrichFindings } from "../../shared/llm/enrich"

const CATEGORY = "Performance"

export type PerfAuditOptions = {
  minSeverity?: Severity
  largeImageBytesThreshold?: number  // varsayılan 1 MB
  largeChunkBytesThreshold?: number  // varsayılan 250 KB
}

export type PerfAuditResult = {
  scanned: {
    csFiles: number
    tsFiles: number
    imageAssets: number
    bundleManifestFound: boolean
  }
  summary: Record<Lowercase<Severity>, number>
  byRule: Record<string, number>
  findings: Finding[]
}

function makeFinding(
  severity: Finding["severity"],
  rule: string,
  file: string,
  line: number,
  message: string,
  impact: string,
  recommendation: string
): Finding {
  return { severity, category: CATEGORY, file, line, rule, message, impact, recommendation }
}

function walkRepo(dir: string, accept: (rel: string, name: string) => boolean, out: string[]): void {
  let items: fs.Dirent[]
  try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const it of items) {
    const full = path.join(dir, it.name)
    const rel = path.relative(CONFIG.ROOT_DIR, full).replace(/\\/g, "/")
    if (it.isDirectory()) {
      if (rel.split("/").some((seg) => CONFIG.EXCLUDED_DIRS.includes(seg))) continue
      walkRepo(full, accept, out)
    } else if (accept(rel, it.name)) {
      out.push(full)
    }
  }
}

// ─── 1) large-image-asset ───────────────────────────────────────────────────
const ASSET_DIRS = ["/public/", "/static/", "/assets/", "/wwwroot/"]
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff"]

function scanLargeImages(threshold: number): { findings: Finding[]; count: number } {
  const findings: Finding[] = []
  const files: string[] = []
  walkRepo(CONFIG.ROOT_DIR, (rel, name) => {
    const lower = name.toLowerCase()
    if (!IMAGE_EXTS.some((ext) => lower.endsWith(ext))) return false
    const relSlash = "/" + rel
    return ASSET_DIRS.some((d) => relSlash.includes(d))
  }, files)

  for (const file of files) {
    let size: number
    try { size = fs.statSync(file).size } catch { continue }
    if (size < threshold) continue
    const kb = Math.round(size / 1024)
    findings.push(makeFinding(
      "Medium", "large-image-asset",
      file, 1,
      `Asset ${(size / 1024 / 1024).toFixed(2)} MB (${kb} KB) — eşik ${(threshold / 1024 / 1024).toFixed(1)} MB.`,
      "Büyük statik asset'ler sayfa yüklemesini, bandwidth tüketimini ve mobile kullanıcı " +
      "deneyimini etkiler. CDN cache miss durumunda her ziyaret pahalıya gelir.",
      "Resmi sıkıştır (TinyPNG, Squoosh) veya modern format'a çevir (WebP/AVIF). " +
      "Next.js için <Image /> komponenti otomatik optimize eder. Çok büyükse " +
      "responsive variant'lar (srcset) üret."
    ))
  }
  return { findings, count: files.length }
}

// ─── 2) useMemo-missing-on-expensive (React heuristic) ─────────────────────
// Heuristik: PascalCase function component içinde 2+ chained array method
//   (.filter / .map / .reduce / .sort) JSX return içinde inline ama
//   useMemo/useCallback ile sarılmamış.
//
// Yanlış pozitifi azaltmak için: hook çağrısı (useMemo/useCallback) varsa skip.

const COMPONENT_RE = /\b(?:export\s+(?:default\s+)?)?(?:function|const)\s+([A-Z]\w+)\s*[(=]/
const CHAIN_RE = /\.(filter|map|reduce|sort|flatMap)\s*\([^)]*\)\s*\.(filter|map|reduce|sort|flatMap)\s*\(/

function scanReactUseMemo(file: string): Finding[] {
  const out: Finding[] = []
  if (!file.toLowerCase().match(/\.(tsx|jsx)$/)) return out
  let text: string
  try { text = fs.readFileSync(file, "utf8") } catch { return out }

  // Dosya bazlı: component tanımı var mı?
  if (!COMPONENT_RE.test(text)) return out

  // useMemo/useCallback hook'u kullanılmış mı?
  const hasMemoHook = /\b(useMemo|useCallback)\s*\(/.test(text)

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (!CHAIN_RE.test(lines[i])) continue
    if (hasMemoHook) {
      // Aynı satırda veya 2 satır öncesinde useMemo zarflama var mı?
      const ctx = lines.slice(Math.max(0, i - 2), i + 1).join("\n")
      if (/\buseMemo\s*\(/.test(ctx)) continue
    }
    out.push(makeFinding(
      "Low", "usememo-missing-on-expensive",
      file, i + 1,
      "Komponent içinde zincirlemiş array method (filter/map/reduce/sort) inline kullanılıyor.",
      "Her render'da yeniden hesaplanır; büyük dizilerde gereksiz CPU yükü ve " +
      "alt komponent re-render tetikleyebilir (referans equality fail).",
      "useMemo ile sar: const items = useMemo(() => arr.filter(...).map(...), [arr]). " +
      "Bağımlılık listesini doğru tut."
    ))
  }
  return out
}

// ─── 3) peer-await-instead-of-whenall (C# + TS) ────────────────────────────
// Heuristik: peş peşe (max 2 satır arada) 3+ await çağrısı, her biri farklı
// değişkene atanıyor ve birbirinden bağımsız görünüyor.
//
// C# pattern:  var a = await X(); var b = await Y(); var c = await Z();
// TS pattern:  const a = await x(); const b = await y(); const c = await z();

const AWAIT_ASSIGN_RE_CS = /^\s*(?:var|[A-Za-z][\w<>?,\s]*?)\s+(\w+)\s*=\s*await\s+/
const AWAIT_ASSIGN_RE_TS = /^\s*(?:const|let|var)\s+(\w+)\s*=\s*await\s+/

function scanPeerAwait(file: string): Finding[] {
  const out: Finding[] = []
  const lower = file.toLowerCase()
  const isCs = lower.endsWith(".cs")
  const isTs = lower.match(/\.(ts|tsx|js|jsx)$/)
  if (!isCs && !isTs) return out

  let text: string
  try { text = fs.readFileSync(file, "utf8") } catch { return out }
  const lines = text.split(/\r?\n/)
  const re = isCs ? AWAIT_ASSIGN_RE_CS : AWAIT_ASSIGN_RE_TS

  // Sliding window: 3 ardışık (≤2 satır boşluk dahil) await assignment var mı?
  let i = 0
  while (i < lines.length) {
    const m = lines[i].match(re)
    if (!m) { i++; continue }
    // Sonraki ardışık await assignment'ları topla
    const cluster: number[] = [i]
    let vars: string[] = [m[1]]
    let j = i + 1
    let gap = 0
    while (j < lines.length && gap <= 2) {
      const mj = lines[j].match(re)
      if (mj) {
        cluster.push(j)
        vars.push(mj[1])
        gap = 0
      } else if (lines[j].trim() === "") {
        gap++
      } else {
        break
      }
      j++
    }
    if (cluster.length >= 3) {
      // Bağımsızlık heuristic: ikinci ve sonraki await ifadeleri önceki var'a refere etmiyor mu?
      let independent = true
      for (let k = 1; k < cluster.length; k++) {
        const callLine = lines[cluster[k]]
        const prevVars = vars.slice(0, k)
        const refersToPrev = prevVars.some((v) => new RegExp(`\\b${v}\\b`).test(callLine))
        if (refersToPrev) { independent = false; break }
      }
      if (independent) {
        out.push(makeFinding(
          "Medium", "peer-await-instead-of-whenall",
          file, cluster[0] + 1,
          `Peş peşe ${cluster.length} bağımsız await çağrısı — Task.WhenAll/Promise.all fırsatı.`,
          "Sıralı await'ler her birinin latency'sini topla — N istek için ~N × t. " +
          "Bağımsız işler paralel çalıştırılabilir; toplam süre max(t_i) olur.",
          isCs
            ? "var (a, b, c) = await (X(), Y(), Z()).WhenAll(); şeklinde paralelle veya " +
              "Task.WhenAll(X(), Y(), Z()) sonra .Result[0/1/2]."
            : "const [a, b, c] = await Promise.all([x(), y(), z()]);"
        ))
      }
    }
    i = j
  }
  return out
}

// ─── 4) linq-materialize-in-loop (C# foreach içinde .ToList/.ToArray) ─────
const LOOP_MATERIALIZE_RE = /\.(ToList|ToArray|ToHashSet|ToDictionary)\s*\(/

function scanLinqMaterializeInLoop(file: string): Finding[] {
  const out: Finding[] = []
  if (!file.toLowerCase().endsWith(".cs")) return out
  let text: string
  try { text = fs.readFileSync(file, "utf8") } catch { return out }
  const lines = text.split(/\r?\n/)

  // Basit brace-counting: foreach { ... } scope'unu izle
  let depth = 0
  let inForeachStack: number[] = []  // her foreach'in açıldığı depth

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // foreach ( ... ) algıla
    if (/^\s*foreach\s*\(/.test(line)) {
      // Bir sonraki açılış brace foreach scope'u
      inForeachStack.push(depth + 1)
    }
    // Brace sayımı (kabaca — string literal/comment göz ardı edilir)
    const opens = (line.match(/\{/g) ?? []).length
    const closes = (line.match(/\}/g) ?? []).length
    depth += opens - closes
    // Foreach scope kapanmış mı?
    inForeachStack = inForeachStack.filter((d) => d <= depth)

    if (inForeachStack.length === 0) continue
    if (!LOOP_MATERIALIZE_RE.test(line)) continue
    // database_audit'in n-plus-one'ı DbContext sorgularına bakar; biz LINQ materialize'a.
    // DbContext kontrolünden farklılaştır: zincirin başında db.X veya DbSet erişimi varsa skip
    // (database_audit zaten yakalıyor).
    if (/\b(_?[a-z]\w*)?(?:Context|Db|_db|_context)\b/i.test(line)) continue

    const m = line.match(LOOP_MATERIALIZE_RE)
    out.push(makeFinding(
      "Medium", "linq-materialize-in-loop",
      file, i + 1,
      `foreach içinde .${m?.[1]}() çağrısı — her iterasyonda gereksiz materialize.`,
      "Her iterasyonda yeni koleksiyon allocation; büyük N'de GC baskısı, gereksiz hafıza/CPU. " +
      "Eğer LINQ zinciri sabit ise döngü dışında bir kez materialize etmek yeterli.",
      "Materialize işlemini döngü öncesi yap ve referansını kullan. " +
      "Eğer her iterasyonda farklı filter parametresi varsa, batch operasyon veya " +
      "Dictionary/Lookup ile O(N) ↦ O(1) lookup'a çevir."
    ))
  }
  return out
}

// ─── 5) bundle-large-chunk (Next.js / webpack stats) ───────────────────────
function scanBundleChunks(threshold: number): Finding[] {
  const out: Finding[] = []
  const candidates = [
    path.join(CONFIG.ROOT_DIR, ".next", "build-manifest.json"),
    path.join(CONFIG.ROOT_DIR, ".next", "static-build-manifest.json"),
    path.join(CONFIG.ROOT_DIR, "frontend", ".next", "build-manifest.json"),
    path.join(CONFIG.ROOT_DIR, "webpack-stats.json"),
    path.join(CONFIG.ROOT_DIR, "bundle-stats.json"),
  ]
  const manifest = candidates.find((p) => fs.existsSync(p))
  if (!manifest) return out

  // .next/build-manifest.json içinde gerçek chunk boyutu yok; .next/static/chunks/ tarayalım
  const chunksDir = path.join(path.dirname(manifest), "static", "chunks")
  if (!fs.existsSync(chunksDir)) {
    // Webpack stats format
    try {
      const stats = JSON.parse(fs.readFileSync(manifest, "utf8")) as { assets?: Array<{ name: string; size: number }> }
      for (const a of stats.assets ?? []) {
        if (a.size > threshold && /\.js$/.test(a.name)) {
          const kb = Math.round(a.size / 1024)
          out.push(makeFinding(
            "Suggestion", "bundle-large-chunk",
            manifest, 1,
            `Bundle chunk '${a.name}' ${kb} KB — eşik ${Math.round(threshold / 1024)} KB.`,
            "Büyük chunk first paint'i geciktirir; mobile/3G kullanıcılarda Time to Interactive artar.",
            "Code splitting (dynamic import), tree-shaking kontrol et, lazy load. " +
            "next.config.js içinde modularizeImports, transpilePackages doğru yapılandır."
          ))
        }
      }
    } catch { /* ignore */ }
    return out
  }

  // .next/static/chunks/*.js dosya boyutlarına bak
  try {
    const items = fs.readdirSync(chunksDir, { withFileTypes: true })
    for (const it of items) {
      if (!it.isFile() || !it.name.endsWith(".js")) continue
      const full = path.join(chunksDir, it.name)
      const size = fs.statSync(full).size
      if (size <= threshold) continue
      const kb = Math.round(size / 1024)
      out.push(makeFinding(
        "Suggestion", "bundle-large-chunk",
        full, 1,
        `Next.js chunk ${kb} KB — eşik ${Math.round(threshold / 1024)} KB.`,
        "Büyük chunk first paint'i geciktirir; özellikle dynamic import edilmemiş " +
        "vendor chunk'lar tüm sayfalara yüklenir.",
        "next.config.js'de webpack.optimization.splitChunks ayarı. " +
        "Büyük bağımlılıkları (chart libs, markdown, vb.) `dynamic(() => import('...'))` ile lazy yükle."
      ))
    }
  } catch { /* ignore */ }
  return out
}

export async function runPerfAudit(options: PerfAuditOptions = {}): Promise<PerfAuditResult> {
  const minSeverity = options.minSeverity ?? "Low"
  const imgThreshold = options.largeImageBytesThreshold ?? 1024 * 1024  // 1 MB
  const chunkThreshold = options.largeChunkBytesThreshold ?? 256 * 1024  // 250 KB

  // Asset taraması
  const { findings: imageFindings, count: imageCount } = scanLargeImages(imgThreshold)

  // Bundle stats — varsa
  const bundleFindings = scanBundleChunks(chunkThreshold)
  const bundleManifestFound = bundleFindings.length > 0 ||
    fs.existsSync(path.join(CONFIG.ROOT_DIR, ".next", "build-manifest.json"))

  // Kod taraması (cs + ts)
  const csFiles: string[] = []
  walkRepo(CONFIG.ROOT_DIR, (_rel, name) => name.endsWith(".cs"), csFiles)
  const tsFiles: string[] = []
  walkRepo(CONFIG.ROOT_DIR, (_rel, name) => /\.(tsx?|jsx?)$/.test(name), tsFiles)

  const findings: Finding[] = [...imageFindings, ...bundleFindings]
  for (const f of tsFiles) findings.push(...scanReactUseMemo(f))
  for (const f of [...csFiles, ...tsFiles]) findings.push(...scanPeerAwait(f))
  for (const f of csFiles) findings.push(...scanLinqMaterializeInLoop(f))

  const filtered = findings.filter((f) => meetsMinSeverity(f.severity, minSeverity))
  const enriched = await enrichFindings({ findings: filtered, roleKey: "performance-engineer" })
  enriched.findings.sort((a, b) =>
    compareSeverityDesc(a.severity, b.severity) ||
    a.file.localeCompare(b.file) ||
    a.line - b.line
  )

  const summary: Record<Lowercase<Severity>, number> = {
    critical: 0, high: 0, medium: 0, low: 0, suggestion: 0,
  }
  const byRule: Record<string, number> = {}
  for (const f of enriched.findings) {
    summary[f.severity.toLowerCase() as Lowercase<Severity>]++
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1
  }

  return {
    scanned: {
      csFiles: csFiles.length,
      tsFiles: tsFiles.length,
      imageAssets: imageCount,
      bundleManifestFound,
    },
    summary,
    byRule,
    findings: enriched.findings,
  }
}
