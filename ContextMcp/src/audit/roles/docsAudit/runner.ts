import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"
import { CONFIG } from "../../../core/config"
import type { Finding } from "../../shared/finding"
import type { Severity } from "../../shared/severity"
import { compareSeverityDesc, meetsMinSeverity } from "../../shared/severity"
import { enrichFindings } from "../../shared/llm/enrich"

const CATEGORY = "Documentation"

export type DocsAuditOptions = {
  minSeverity?: Severity
  readmeStaleDays?: number       // default 180
  claudeMdStaleDays?: number     // default 90 (Claude talimatları daha sık güncellenmeli)
  activeDocStaleDays?: number    // default 90
  runbookStaleDays?: number      // default 365
}

export type DocsAuditResult = {
  scanned: {
    readmeFiles: number
    claudeMdFiles: number
    docsMdFiles: number
    adrFiles: number
    runbookFiles: number
    csPublicApiFiles: number
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

function gitExec(args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: CONFIG.ROOT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch {
    return ""
  }
}

function isGitRepo(): boolean {
  return gitExec(["rev-parse", "--is-inside-work-tree"]).trim() === "true"
}

// Bir dosyanın son commit epoch'unu döner (saniye). Dosya yoksa veya git yoksa 0.
function lastCommitEpoch(absFile: string): number {
  const rel = path.relative(CONFIG.ROOT_DIR, absFile).replace(/\\/g, "/")
  const out = gitExec(["log", "-1", "--format=%ct", "--", rel]).trim()
  return out ? parseInt(out, 10) : 0
}

// Bir klasördeki commit sayısını döner (`-- path` ile sınırlı).
function commitCountSince(absPath: string, sinceEpoch: number): number {
  if (!sinceEpoch) return 0
  const rel = path.relative(CONFIG.ROOT_DIR, absPath).replace(/\\/g, "/")
  const out = gitExec([
    "log", "--oneline", `--since=${sinceEpoch}`, "--", rel || "."
  ])
  return out ? out.split(/\r?\n/).filter(Boolean).length : 0
}

// ─── 1) Markdown link rot — README/CLAUDE.md/docs/**/*.md ────────────────────
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g

function scanMarkdownLinkRot(allMdFiles: string[]): Finding[] {
  const findings: Finding[] = []
  for (const file of allMdFiles) {
    let text: string
    try { text = fs.readFileSync(file, "utf8") } catch { continue }
    const lines = text.split(/\r?\n/)
    const dir = path.dirname(file)

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      MARKDOWN_LINK_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = MARKDOWN_LINK_RE.exec(line)) !== null) {
        const linkText = m[1]
        const target = m[2]
        // Sadece relative path'leri kontrol et
        if (/^https?:\/\//i.test(target)) continue
        if (target.startsWith("mailto:") || target.startsWith("#")) continue
        if (target.startsWith("/")) continue  // absolute URL path — kontrol etme

        // Hedef dosya/dizin
        const resolved = path.resolve(dir, target)
        if (!fs.existsSync(resolved)) {
          findings.push(makeFinding(
            "Medium",
            "markdown-link-rot",
            file, i + 1,
            `Kırık markdown linki: '${linkText}' → '${target}' (hedef yok).`,
            "Dökümandaki kırık link okuyucuyu yanıltır; teknik dökümanda referansların yanlış " +
            "dosyayı işaret etmesi yeni geliştiricilerin onboarding'ini bozar.",
            "Linki düzelt veya kaldır. Refactor sonrası taşınan dosyalar için bir checklist tut."
          ))
        }
      }
    }
  }
  return findings
}

// ─── 2) CLAUDE.md broken references (kod/path referansları) ──────────────────
// CLAUDE.md ve docs içinde backtick'li kod referansları: `docs/runbooks/X.md`, `src/audit/...`
const BACKTICK_PATH_RE = /`([a-zA-Z0-9_./-]+\.(?:md|cs|ts|tsx|json|yml|yaml))`/g

function scanClaudeMdBrokenReferences(claudeMdFiles: string[], docsMdFiles: string[]): Finding[] {
  const findings: Finding[] = []
  const targets = [...claudeMdFiles, ...docsMdFiles]
  for (const file of targets) {
    let text: string
    try { text = fs.readFileSync(file, "utf8") } catch { continue }
    const lines = text.split(/\r?\n/)

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      BACKTICK_PATH_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = BACKTICK_PATH_RE.exec(line)) !== null) {
        const target = m[1]
        if (target.includes("..")) continue  // tipik relative — skip
        // CTX_ROOT veya dosya klasörüne göre dene
        const fromRoot = path.join(CONFIG.ROOT_DIR, target)
        const fromDir = path.join(path.dirname(file), target)
        if (!fs.existsSync(fromRoot) && !fs.existsSync(fromDir)) {
          const isClaudeMd = /\bCLAUDE\.md$/i.test(file)
          findings.push(makeFinding(
            isClaudeMd ? "High" : "Medium",
            "claude-md-broken-reference",
            file, i + 1,
            `Kod/path referansı kırık: \`${target}\`.`,
            isClaudeMd
              ? "CLAUDE.md Claude'a talimat verir; kırık referans Claude'un yanlış yerde " +
                "arama yapmasına ve hayali dosyalardan bahsetmesine yol açar."
              : "Doc içindeki kod referansının hedefi yok; okuyucu kaybolur.",
            "Path'i güncelle veya referansı kaldır. Refactor sonrası CLAUDE.md'leri " +
            "ayrıca gözden geçir (kod modülleri taşındığında AI talimatları kırılır)."
          ))
        }
      }
    }
  }
  return findings
}

// ─── 3) Freshness: README / CLAUDE.md / active / runbook ────────────────────
function scanFreshness(
  readmes: string[],
  claudeMds: string[],
  activeFiles: string[],
  runbooks: string[],
  thresholds: { readmeStale: number; claudeMdStale: number; activeStale: number; runbookStale: number },
  hasGit: boolean
): Finding[] {
  if (!hasGit) return []
  const findings: Finding[] = []
  const nowSec = Math.floor(Date.now() / 1000)

  // README freshness — sadece commit aktivitesi var ise tetikle
  for (const file of readmes) {
    const epoch = lastCommitEpoch(file)
    if (!epoch) continue
    const daysOld = Math.floor((nowSec - epoch) / 86400)
    if (daysOld < thresholds.readmeStale) continue
    const sinceCommits = commitCountSince(path.dirname(file), epoch)
    if (sinceCommits < 50) continue
    findings.push(makeFinding(
      "Low", "readme-stale",
      file, 1,
      `README ${daysOld} gün önce güncellendi, o günden beri ${sinceCommits} commit var.`,
      "Eski README yeni geliştiriciye yanlış kurulum/kullanım talimatı verir; " +
      "araç ekosistemi, env değişkenleri veya komutlar değişmiş olabilir.",
      "README'yi gözden geçir: yapılandırma, komutlar, gereksinimler hâlâ doğru mu?"
    ))
  }

  // CLAUDE.md freshness — claude talimatları daha sık taze tutulmalı
  for (const file of claudeMds) {
    const epoch = lastCommitEpoch(file)
    if (!epoch) continue
    const daysOld = Math.floor((nowSec - epoch) / 86400)
    if (daysOld < thresholds.claudeMdStale) continue
    const sinceCommits = commitCountSince(path.dirname(file), epoch)
    if (sinceCommits < 20) continue
    findings.push(makeFinding(
      "Low", "claude-md-stale",
      file, 1,
      `CLAUDE.md ${daysOld} gün önce güncellendi, o günden beri ${sinceCommits} commit var (modülde aktif değişim).`,
      "CLAUDE.md yaşayan talimat dosyasıdır; modül değişirken AI'ya verilen kılavuz " +
      "güncel kalmazsa Claude eski pattern'leri uygulamaya devam eder.",
      "CLAUDE.md'yi modül son durumuna göre revize et. Özellikle değişen API'lar, " +
      "yeni kurallar veya geçersiz pattern'ler için."
    ))
  }

  // Active docs — kalıcılaşmış mı?
  for (const file of activeFiles) {
    const epoch = lastCommitEpoch(file)
    if (!epoch) continue
    const daysOld = Math.floor((nowSec - epoch) / 86400)
    if (daysOld < thresholds.activeStale) continue
    findings.push(makeFinding(
      "Suggestion", "stale-active-doc",
      file, 1,
      `'active/' altındaki doküman ${daysOld} gün dokunulmamış.`,
      "'active' klasörü kısa ömürlü çalışma dosyaları içindir; uzun süre kalan dosyalar " +
      "tamamlanmış (archive'a taşı) veya unutulmuş (sil) olabilir.",
      "Dosyayı sonuçlandır ve archive/done klasörüne taşı, veya artık geçerli değilse sil."
    ))
  }

  // Runbook freshness
  for (const file of runbooks) {
    const epoch = lastCommitEpoch(file)
    if (!epoch) continue
    const daysOld = Math.floor((nowSec - epoch) / 86400)
    if (daysOld < thresholds.runbookStale) continue
    findings.push(makeFinding(
      "Low", "runbook-no-recent-update",
      file, 1,
      `Runbook ${daysOld} gün güncellenmemiş.`,
      "Operasyonel runbook'lar altyapı/araç değiştikçe güncellenmezse incident sırasında " +
      "yanlış adımlar uygulanır; MTTR uzar.",
      "Runbook'u review et: komutlar, dashboard linkleri, servis adları hâlâ geçerli mi? " +
      "Geçerliyse 'Last reviewed: YYYY-MM-DD' başlığı ekleyerek revize tarihini güncelle."
    ))
  }

  return findings
}

// ─── 4) CHANGELOG behind git ─────────────────────────────────────────────────
function scanChangelog(hasGit: boolean): Finding[] {
  if (!hasGit) return []
  const findings: Finding[] = []
  const candidates = [
    path.join(CONFIG.ROOT_DIR, "CHANGELOG.md"),
    path.join(CONFIG.ROOT_DIR, "CHANGELOG"),
    path.join(CONFIG.ROOT_DIR, "CHANGES.md"),
  ]
  const changelog = candidates.find((c) => fs.existsSync(c))
  if (!changelog) return []  // CHANGELOG yoksa skip (zorunlu değil)

  const tags = gitExec(["tag", "--sort=-creatordate"]).split(/\r?\n/).filter(Boolean)
  if (tags.length === 0) return []
  const lastTag = tags[0]
  const commitsSinceTag = gitExec(["log", `${lastTag}..HEAD`, "--oneline"]).split(/\r?\n/).filter(Boolean).length
  if (commitsSinceTag === 0) return []

  let text: string
  try { text = fs.readFileSync(changelog, "utf8") } catch { return [] }
  if (text.includes(lastTag)) {
    // Tag CHANGELOG'da var; "Unreleased" bölümü var mı?
    if (!/##\s+\[?unreleased\]?/i.test(text)) {
      findings.push(makeFinding(
        "Medium", "changelog-behind-git",
        changelog, 1,
        `Son tag ${lastTag}'tan beri ${commitsSinceTag} commit var, CHANGELOG'da Unreleased bölümü yok.`,
        "Yayınlanmamış değişiklikler CHANGELOG'da yer almazsa kullanıcılar yeni feature/fix'leri " +
        "release notes'ta görmez; release manager için izleme zorlaşır.",
        "CHANGELOG'da '## [Unreleased]' başlığı altında commit özetlerini topla."
      ))
    }
  }
  return findings
}

// ─── 5) ADR kalite (varsa) ──────────────────────────────────────────────────
function findAdrDir(): string | null {
  const candidates = [
    path.join(CONFIG.ROOT_DIR, "docs", "adr"),
    path.join(CONFIG.ROOT_DIR, "docs", "decisions"),
    path.join(CONFIG.ROOT_DIR, "adr"),
  ]
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isDirectory()) ?? null
}

function scanAdrQuality(adrDir: string | null): { findings: Finding[]; files: string[] } {
  const findings: Finding[] = []
  if (!adrDir) return { findings, files: [] }

  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(adrDir, { withFileTypes: true }) } catch { return { findings, files: [] } }
  const adrFiles = entries
    .filter((e) => e.isFile() && /\.md$/i.test(e.name))
    .map((e) => path.join(adrDir, e.name))

  // Naming pattern tespit et (ADR-NNN-... veya NNN-...)
  const counts = { dashed: 0, plain: 0 }
  for (const f of adrFiles) {
    const base = path.basename(f)
    if (/^ADR[-_]\d+/i.test(base)) counts.dashed++
    else if (/^\d+[-_]/.test(base)) counts.plain++
  }
  const dominantPattern: "dashed" | "plain" | null =
    counts.dashed > counts.plain ? "dashed" : counts.plain > counts.dashed ? "plain" : null

  for (const f of adrFiles) {
    let text: string
    try { text = fs.readFileSync(f, "utf8") } catch { continue }
    const base = path.basename(f)

    // Status
    const hasStatusHeader = /^#+\s+status\b/im.test(text) || /^status\s*:/im.test(text)
    if (!hasStatusHeader) {
      findings.push(makeFinding(
        "Low", "adr-missing-status",
        f, 1,
        `ADR'da Status bölümü yok.`,
        "ADR status'ü (Accepted / Proposed / Deprecated / Superseded) belirsizse okuyucu " +
        "kararın hâlâ geçerli olup olmadığını bilemez; eski ADR'lar yanlış uygulanır.",
        "ADR'a 'Status: Accepted' satırı veya '## Status' başlığı ekle."
      ))
    } else if (/superseded/i.test(text) && !/superseded\s+by/i.test(text)) {
      findings.push(makeFinding(
        "Suggestion", "adr-superseded-without-link",
        f, 1,
        `ADR 'Superseded' ama hangi ADR ile değiştirildiği belirtilmemiş.`,
        "Superseded ADR'nin nereye götürdüğü belirsizse readers iz süremez.",
        "Status satırına 'Superseded by ADR-XXX' veya markdown link ekle."
      ))
    }

    // Naming drift
    if (dominantPattern === "dashed" && !/^ADR[-_]\d+/i.test(base)) {
      findings.push(makeFinding(
        "Low", "adr-naming-drift",
        f, 1,
        `ADR dosya adı '${base}' baskın kalıba (ADR-NNN-...) uymuyor.`,
        "Tutarsız ADR isimleri sıralamayı bozar, listeleme/dizin oluşturmayı zorlaştırır.",
        `Dosyayı 'ADR-NNN-<slug>.md' kalıbına yeniden adlandır.`
      ))
    } else if (dominantPattern === "plain" && !/^\d+[-_]/.test(base)) {
      findings.push(makeFinding(
        "Low", "adr-naming-drift",
        f, 1,
        `ADR dosya adı '${base}' baskın kalıba (NNN-...) uymuyor.`,
        "Tutarsız ADR isimleri dizinleme/sıralamayı bozar.",
        `Dosyayı 'NNN-<slug>.md' kalıbına yeniden adlandır.`
      ))
    }
  }
  return { findings, files: adrFiles }
}

// ─── 6) CLAUDE.md → ADR link kontrolü ───────────────────────────────────────
function scanClaudeMdAdrLink(claudeMds: string[], adrFiles: string[]): Finding[] {
  if (adrFiles.length === 0) return []
  const rootClaudeMd = claudeMds.find((f) => path.dirname(f) === CONFIG.ROOT_DIR ||
                                              path.relative(CONFIG.ROOT_DIR, path.dirname(f)) === "docs")
  if (!rootClaudeMd) return []
  let text: string
  try { text = fs.readFileSync(rootClaudeMd, "utf8") } catch { return [] }
  const mentionsAdr = /\bADR[-_\s]\d+/i.test(text) || /docs\/(adr|decisions)\//i.test(text)
  if (mentionsAdr) return []
  return [makeFinding(
    "Suggestion", "claude-md-missing-adr-link",
    rootClaudeMd, 1,
    `${adrFiles.length} ADR var ama kök CLAUDE.md'sinde hiçbirine atıf yok.`,
    "ADR'lar mimari kararları tutar; Claude bunlardan haberdar olmazsa eski/yeni " +
    "pattern'leri ayırt edemeyebilir.",
    "CLAUDE.md'ye 'See docs/decisions/ for architecture decisions' tarzı bir bölüm ekle, " +
    "veya kritik ADR'lara doğrudan link ver."
  )]
}

// ─── 7) Modül-bazlı context doc eksikliği ──────────────────────────────────
function scanModuleContextDoc(): Finding[] {
  const findings: Finding[] = []
  const manifestFiles: string[] = []
  walkRepo(CONFIG.ROOT_DIR, (rel, name) =>
    (name.endsWith(".csproj") || name === "package.json") && !rel.includes("node_modules/"),
    manifestFiles
  )

  for (const manifest of manifestFiles) {
    const moduleDir = path.dirname(manifest)
    // Kök zaten projenin ana README'sini kapsar — atla
    if (moduleDir === CONFIG.ROOT_DIR) continue

    const hasReadme = fs.existsSync(path.join(moduleDir, "README.md"))
    const hasClaudeMd = fs.existsSync(path.join(moduleDir, "CLAUDE.md"))
    // docs/context/<modül-adı>.md var mı?
    const moduleName = path.basename(moduleDir)
    const contextDoc = path.join(CONFIG.ROOT_DIR, "docs", "context", `${moduleName}.md`)
    const hasContextDoc = fs.existsSync(contextDoc)

    if (!hasReadme && !hasClaudeMd && !hasContextDoc) {
      findings.push(makeFinding(
        "Low", "module-missing-context-doc",
        manifest, 1,
        `Modül '${moduleName}' için README/CLAUDE.md veya docs/context/${moduleName}.md yok.`,
        "Bağımsız modüller (.csproj / package.json içeren klasörler) kendi rolünü/sorumluluğunu " +
        "açıklamalı; yoksa yeni geliştirici klasöre bakıp ne yaptığını çıkarmak zorunda kalır.",
        `Şunlardan birini ekle: ${moduleName}/README.md (modül kullanım dokümanı), ` +
        `${moduleName}/CLAUDE.md (Claude için talimat), veya docs/context/${moduleName}.md (genel context).`
      ))
    }
  }
  return findings
}

// ─── 8) Public API XML doc eksikliği (basit text scan) ──────────────────────
const PUBLIC_DECL_RE = /^\s*public\s+(?:abstract\s+|sealed\s+|static\s+|partial\s+|virtual\s+|override\s+|async\s+)*(?:class|record|interface|struct|enum|[A-Z][a-zA-Z0-9_<>?\[\],\s]+\s+[A-Z][a-zA-Z0-9_]+\s*\()/

function scanXmlDocOnPublicApi(): { findings: Finding[]; files: string[] } {
  const findings: Finding[] = []
  // Sadece "API" benzeri klasörlerde — false positive azaltma
  const csFiles: string[] = []
  walkRepo(CONFIG.ROOT_DIR, (rel, name) => {
    if (!name.endsWith(".cs")) return false
    const lower = rel.toLowerCase()
    return lower.includes("/api/") || lower.includes("/controllers/") || lower.includes("/publicapi/")
  }, csFiles)

  for (const file of csFiles) {
    let text: string
    try { text = fs.readFileSync(file, "utf8") } catch { continue }
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!PUBLIC_DECL_RE.test(line)) continue
      const prev1 = i >= 1 ? lines[i - 1].trim() : ""
      const prev2 = i >= 2 ? lines[i - 2].trim() : ""
      const hasXmlDoc = prev1.startsWith("///") || prev2.startsWith("///")
      if (!hasXmlDoc) {
        findings.push(makeFinding(
          "Low", "xml-doc-missing-on-public-api",
          file, i + 1,
          `Public API üyesinde XML doc yok.`,
          "Public API'lar IntelliSense/Swagger için XML doc'a ihtiyaç duyar; " +
          "doc'suz public API API tüketicisinin sezgisel kullanımını zorlaştırır.",
          "Üzerine '/// <summary>...' yorumu ekle. Solution-wide otomasyon için " +
          ".csproj'da <GenerateDocumentationFile>true</GenerateDocumentationFile>."
        ))
      }
    }
  }
  return { findings, files: csFiles }
}

// ─── Orchestrator ──────────────────────────────────────────────────────────
export async function runDocsAudit(options: DocsAuditOptions = {}): Promise<DocsAuditResult> {
  const minSeverity = options.minSeverity ?? "Low"
  const thresholds = {
    readmeStale: options.readmeStaleDays ?? 180,
    claudeMdStale: options.claudeMdStaleDays ?? 90,
    activeStale: options.activeDocStaleDays ?? 90,
    runbookStale: options.runbookStaleDays ?? 365,
  }
  const hasGit = isGitRepo()

  // Dosya toplama
  const readmes: string[] = []
  walkRepo(CONFIG.ROOT_DIR, (_rel, name) => /^README(\..+)?\.md$/i.test(name), readmes)

  const claudeMds: string[] = []
  walkRepo(CONFIG.ROOT_DIR, (_rel, name) => name === "CLAUDE.md", claudeMds)

  const docsMdFiles: string[] = []
  walkRepo(CONFIG.ROOT_DIR, (rel, name) => rel.startsWith("docs/") && name.endsWith(".md"), docsMdFiles)

  const activeFiles: string[] = []
  walkRepo(CONFIG.ROOT_DIR, (rel, name) =>
    (rel.startsWith("docs/active/") || rel.startsWith("docs/wip/")) && name.endsWith(".md"),
    activeFiles
  )

  const runbooks: string[] = []
  walkRepo(CONFIG.ROOT_DIR, (rel, name) =>
    rel.startsWith("docs/runbooks/") && name.endsWith(".md"),
    runbooks
  )

  const adrDir = findAdrDir()
  const adrResult = scanAdrQuality(adrDir)
  const apiResult = scanXmlDocOnPublicApi()

  // Tüm markdown'lar (link rot için)
  const allMd = [...new Set([...readmes, ...claudeMds, ...docsMdFiles])]

  // Kuralları çalıştır
  const all: Finding[] = [
    ...scanMarkdownLinkRot(allMd),
    ...scanClaudeMdBrokenReferences(claudeMds, docsMdFiles),
    ...scanFreshness(readmes, claudeMds, activeFiles, runbooks, thresholds, hasGit),
    ...scanChangelog(hasGit),
    ...adrResult.findings,
    ...scanClaudeMdAdrLink(claudeMds, adrResult.files),
    ...scanModuleContextDoc(),
    ...apiResult.findings,
  ].filter((f) => meetsMinSeverity(f.severity, minSeverity))

  const enriched = await enrichFindings({ findings: all, roleKey: "documentation-writer" })
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
      readmeFiles: readmes.length,
      claudeMdFiles: claudeMds.length,
      docsMdFiles: docsMdFiles.length,
      adrFiles: adrResult.files.length,
      runbookFiles: runbooks.length,
      csPublicApiFiles: apiResult.files.length,
    },
    summary,
    byRule,
    findings: enriched.findings,
  }
}

