import ts from "typescript"
import { getProgram } from "../../../ts/tsIncremental"
import { CONFIG } from "../../../core/config"
import { findRelevantFiles } from "../../shared/queryDriven"
import type { Finding } from "../../shared/finding"
import type { Severity } from "../../shared/severity"
import { compareSeverityDesc, meetsMinSeverity } from "../../shared/severity"
import { walk, lineOf } from "../../../review/tsRule"
import { enrichFindings } from "../../shared/llm/enrich"

const CATEGORY = "Accessibility"

export type A11yAuditOptions = {
  query?: string
  minSeverity?: Severity
}

export type A11yAuditResult = {
  filesScanned: number
  summary: Record<Lowercase<Severity>, number>
  byRule: Record<string, number>
  findings: Finding[]
}

// ─── İstisna mekanizması (frontend_compliance pattern'i) ────────────────────
function getAllowedRules(sf: ts.SourceFile): Set<string> {
  const allowed = new Set<string>()
  const re = /\/\/\s*@a11y-audit-allow:\s*([a-z0-9,\-\s]+)/gi
  let match
  while ((match = re.exec(sf.text)) !== null) {
    for (const r of match[1].split(/[,\s]+/).filter(Boolean)) allowed.add(r)
  }
  return allowed
}

function isLineAllowed(sf: ts.SourceFile, line: number, rule: string): boolean {
  const lines = sf.text.split(/\r?\n/)
  const prev = lines[line - 2] ?? ""
  const re = /\/\/\s*@a11y-audit-allow:\s*([a-z0-9,\-\s]+)/i
  const m = prev.match(re)
  if (!m) return false
  return m[1].split(/[,\s]+/).filter(Boolean).includes(rule)
}

// ─── JSX helpers ───────────────────────────────────────────────────────────
function tagName(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string {
  return ts.isIdentifier(node.tagName) ? node.tagName.text : ""
}

function hasAttribute(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string): boolean {
  return node.attributes.properties.some((p) => {
    if (!ts.isJsxAttribute(p)) return false
    return ts.isIdentifier(p.name) && p.name.text === name
  })
}

function getAttributeValue(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string): string | null {
  for (const p of node.attributes.properties) {
    if (!ts.isJsxAttribute(p)) continue
    if (!ts.isIdentifier(p.name) || p.name.text !== name) continue
    const init = p.initializer
    if (!init) return ""  // `<a disabled />` gibi
    if (ts.isStringLiteral(init)) return init.text
    return "(expr)"  // JsxExpression — dinamik, değeri bilemiyoruz
  }
  return null
}

// JsxElement içinde hiç text node (boş olmayan) var mı?
function hasTextChild(element: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean {
  // JsxSelfClosingElement'in çocuğu yok
  if (ts.isJsxSelfClosingElement(element)) return false
  // JsxOpeningElement'in parent'ı JsxElement'tir
  const parent = element.parent
  if (!parent || !ts.isJsxElement(parent)) return false
  for (const child of parent.children) {
    if (ts.isJsxText(child) && child.text.trim().length > 0) return true
    // JsxExpression {someVar} → dinamik, içerik olarak varsay
    if (ts.isJsxExpression(child) && child.expression) return true
  }
  return false
}

function makeFinding(
  severity: Finding["severity"],
  rule: string,
  sf: ts.SourceFile,
  node: ts.Node,
  message: string,
  impact: string,
  recommendation: string
): Finding {
  return {
    severity,
    category: CATEGORY,
    file: sf.fileName,
    line: lineOf(sf, node.getStart(sf)),
    rule,
    message,
    impact,
    recommendation,
  }
}

// ─── Kural 1: img-without-alt ──────────────────────────────────────────────
function checkImgAlt(sf: ts.SourceFile, allowed: Set<string>): Finding[] {
  const out: Finding[] = []
  walk(sf, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
    if (tagName(node) !== "img") return

    // Decoratif resim skip
    if (getAttributeValue(node, "aria-hidden") === "true") return
    const role = getAttributeValue(node, "role")
    if (role === "presentation" || role === "none") return

    if (hasAttribute(node, "alt")) return

    const rule = "img-without-alt"
    if (allowed.has(rule)) return
    const ln = lineOf(sf, node.getStart(sf))
    if (isLineAllowed(sf, ln, rule)) return

    out.push(makeFinding(
      "Medium", rule, sf, node,
      "<img> alt attribute yok.",
      "Screen reader resmin ne gösterdiğini söyleyemez; görme engelli kullanıcı içerik kaybeder. " +
      "Search engine ve sosyal medya paylaşımları da bilgi kaybeder.",
      "Anlamlı bir alt yaz: alt=\"<açıklayıcı metin>\". Dekoratif resim ise alt=\"\" + " +
      "aria-hidden=\"true\" veya role=\"presentation\"."
    ))
  })
  return out
}

// ─── Kural 2: button-no-accessible-name ────────────────────────────────────
function checkButtonName(sf: ts.SourceFile, allowed: Set<string>): Finding[] {
  const out: Finding[] = []
  walk(sf, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
    if (tagName(node) !== "button") return

    if (hasAttribute(node, "aria-label")) return
    if (hasAttribute(node, "aria-labelledby")) return
    if (hasAttribute(node, "title")) return
    if (hasTextChild(node)) return  // <button>Save</button> — OK

    const rule = "button-no-accessible-name"
    if (allowed.has(rule)) return
    const ln = lineOf(sf, node.getStart(sf))
    if (isLineAllowed(sf, ln, rule)) return

    out.push(makeFinding(
      "High", rule, sf, node,
      "<button> erişilebilir bir ad'a sahip değil (text/aria-label/aria-labelledby/title yok).",
      "Screen reader yalnız \"button\" diye okur, ne yaptığı anlaşılmaz. Klavye/screen-reader " +
      "kullanıcısı butonun amacını bilemez.",
      "İçine metin koy, **veya** ikon-only ise aria-label ekle: " +
      "<button aria-label=\"Sil\"><DeleteIcon /></button>. " +
      "Bilinçli istisnalar için satır üstüne // @a11y-audit-allow: button-no-accessible-name — <gerekçe>."
    ))
  })
  return out
}

// ─── Kural 3: input-without-label ──────────────────────────────────────────
const SELF_LABELING_TYPES = new Set(["hidden", "submit", "button", "reset"])

function checkInputLabel(sf: ts.SourceFile, allowed: Set<string>): Finding[] {
  const out: Finding[] = []

  // Aynı dosyadaki <label htmlFor="..."> değerlerini topla
  const labelFors = new Set<string>()
  walk(sf, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
    if (tagName(node) !== "label") return
    const v = getAttributeValue(node, "htmlFor") ?? getAttributeValue(node, "for")
    if (v && v !== "(expr)") labelFors.add(v)
  })

  walk(sf, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
    if (tagName(node) !== "input") return

    const type = getAttributeValue(node, "type") ?? "text"
    if (SELF_LABELING_TYPES.has(type)) return

    if (hasAttribute(node, "aria-label")) return
    if (hasAttribute(node, "aria-labelledby")) return

    // id varsa ve aynı dosyada <label htmlFor="id"> varsa OK
    const id = getAttributeValue(node, "id")
    if (id && id !== "(expr)" && labelFors.has(id)) return

    const rule = "input-without-label"
    if (allowed.has(rule)) return
    const ln = lineOf(sf, node.getStart(sf))
    if (isLineAllowed(sf, ln, rule)) return

    out.push(makeFinding(
      "High", rule, sf, node,
      `<input type=\"${type}\"> bir label ile ilişkilendirilmemiş.`,
      "Screen reader input'un amacını okuyamaz; form kullanılamaz hâle gelir. " +
      "Otomatik form doldurma da label semantiğine bağlı çalışır.",
      "Üstüne <label htmlFor=\"<id>\">Açıklama</label> + input id=\"<id>\" ekle, " +
      "veya input'a aria-label=\"<açıklama>\"."
    ))
  })
  return out
}

// ─── Kural 4: link-no-href ─────────────────────────────────────────────────
function checkLinkHref(sf: ts.SourceFile, allowed: Set<string>): Finding[] {
  const out: Finding[] = []
  walk(sf, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
    if (tagName(node) !== "a") return
    if (hasAttribute(node, "href")) return

    const rule = "link-no-href"
    if (allowed.has(rule)) return
    const ln = lineOf(sf, node.getStart(sf))
    if (isLineAllowed(sf, ln, rule)) return

    out.push(makeFinding(
      "Medium", rule, sf, node,
      "<a> href olmadan kullanılıyor (link-button confusion).",
      "href olmadan link tab navigation'a girmez ve semantic olarak link değil; " +
      "screen reader \"link\" diye okumaz. Klavye kullanıcısı erişemez.",
      "Eğer eylem (action) ise <button> kullan. Gerçek navigasyon ise href ekle. " +
      "Router için onClick + href=\"#\" ANTI-PATTERN — Next.js Link, React Router NavLink kullan."
    ))
  })
  return out
}

// ─── Kural 5: div-as-button ────────────────────────────────────────────────
const NON_INTERACTIVE_TAGS = new Set(["div", "span", "p", "section"])
const KEY_HANDLERS = ["onKeyDown", "onKeyPress", "onKeyUp"]

function checkDivAsButton(sf: ts.SourceFile, allowed: Set<string>): Finding[] {
  const out: Finding[] = []
  walk(sf, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
    const t = tagName(node)
    if (!NON_INTERACTIVE_TAGS.has(t)) return
    if (!hasAttribute(node, "onClick")) return

    // Tam interaktif pattern: role="button" + tabIndex + key handler
    const role = getAttributeValue(node, "role")
    const hasRole = role === "button" || role === "link"
    const hasTabIndex = hasAttribute(node, "tabIndex")
    const hasKey = KEY_HANDLERS.some((k) => hasAttribute(node, k))
    if (hasRole && hasTabIndex && hasKey) return

    const rule = "div-as-button"
    if (allowed.has(rule)) return
    const ln = lineOf(sf, node.getStart(sf))
    if (isLineAllowed(sf, ln, rule)) return

    out.push(makeFinding(
      "Medium", rule, sf, node,
      `<${t}> onClick ile interaktif yapılmış ama semantic değil.`,
      "Klavye-only kullanıcı Tab ile odaklanamaz, Enter/Space tetiklemez. Screen reader " +
      "elemanı button olarak tanımaz. Engelliler için sıkça karşılaşılan kritik hata.",
      `Tercihen <button> kullan. Eğer <${t}> kalmak zorundaysa: ` +
      `role=\"button\" + tabIndex={0} + onKeyDown ekle (Enter/Space → onClick).`
    ))
  })
  return out
}

// ─── Kural 6: heading-skip-level ───────────────────────────────────────────
function checkHeadingOrder(sf: ts.SourceFile, allowed: Set<string>): Finding[] {
  const out: Finding[] = []
  const headings: Array<{ level: number; node: ts.Node }> = []
  walk(sf, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
    const t = tagName(node)
    const m = t.match(/^h([1-6])$/)
    if (m) headings.push({ level: parseInt(m[1], 10), node })
  })
  if (headings.length < 2) return out

  let lastLevel = 0
  for (const h of headings) {
    if (lastLevel > 0 && h.level > lastLevel + 1) {
      const rule = "heading-skip-level"
      if (allowed.has(rule)) {
        lastLevel = h.level
        continue
      }
      const ln = lineOf(sf, h.node.getStart(sf))
      if (isLineAllowed(sf, ln, rule)) {
        lastLevel = h.level
        continue
      }
      out.push(makeFinding(
        "Low", rule, sf, h.node,
        `Heading sıralaması atlanmış: h${lastLevel} sonrası h${h.level} (h${lastLevel + 1} eksik).`,
        "Screen reader doküman yapısını başlık seviyelerinden çıkarır; atlama yapısal " +
        "anlamı bozar ve okuyucu hiyerarşiyi yanlış yorumlar.",
        `h${lastLevel + 1} ekle, veya bu başlığı h${lastLevel + 1} seviyesine indir. ` +
        `Görsel boyut için CSS kullan, semantik seviyeyi atlamak değil.`
      ))
    }
    lastLevel = h.level
  }
  return out
}

// ─── Kural 7: lang-not-set ─────────────────────────────────────────────────
// Sadece "root" tipi dosyalarda. Heuristic: dosya yolu sonu.
function isRootLayoutFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/").toLowerCase()
  return (
    /\/app\/layout\.(tsx|jsx|ts|js)$/.test(norm) ||
    /\/pages\/_document\.(tsx|jsx|ts|js)$/.test(norm) ||
    /\/index\.html$/.test(norm) ||
    /\/public\/index\.html$/.test(norm)
  )
}

function checkLangAttribute(sf: ts.SourceFile, allowed: Set<string>): Finding[] {
  if (!isRootLayoutFile(sf.fileName)) return []
  const out: Finding[] = []
  walk(sf, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
    if (tagName(node) !== "html") return
    if (hasAttribute(node, "lang")) return

    const rule = "lang-not-set"
    if (allowed.has(rule)) return
    const ln = lineOf(sf, node.getStart(sf))
    if (isLineAllowed(sf, ln, rule)) return

    out.push(makeFinding(
      "Low", rule, sf, node,
      "<html> lang attribute yok.",
      "Screen reader sayfanın dilini bilemez; yanlış telaffuz/aksan kullanır. Çeviri " +
      "araçları, arama motorları da sayfayı yanlış dilde indexler.",
      "<html lang=\"tr\"> veya <html lang=\"en\">. Çoklu dil destekli uygulamada " +
      "runtime'da set et (Next.js: layout.tsx'te lang prop)."
    ))
  })
  return out
}

// ─── Orchestrator ─────────────────────────────────────────────────────────
function isJsxFile(file: string): boolean {
  const lower = file.toLowerCase()
  return lower.endsWith(".tsx") || lower.endsWith(".jsx")
}

function collectFiles(query?: string): string[] {
  if (query) {
    const relevant = findRelevantFiles(query)
    return relevant.all.filter(isJsxFile)
  }
  const program = getProgram()
  const root = CONFIG.ROOT_DIR.replace(/\\/g, "/").toLowerCase()
  const out: string[] = []
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue
    const norm = sf.fileName.replace(/\\/g, "/").toLowerCase()
    if (!norm.startsWith(root)) continue
    if (isJsxFile(sf.fileName)) out.push(sf.fileName)
  }
  return out
}

export async function runA11yAudit(options: A11yAuditOptions = {}): Promise<A11yAuditResult> {
  const minSeverity = options.minSeverity ?? "Low"
  const files = collectFiles(options.query)
  const program = getProgram()

  const findings: Finding[] = []
  for (const file of files) {
    const sf = program.getSourceFile(file)
    if (!sf) continue
    const allowed = getAllowedRules(sf)
    try {
      findings.push(...checkImgAlt(sf, allowed))
      findings.push(...checkButtonName(sf, allowed))
      findings.push(...checkInputLabel(sf, allowed))
      findings.push(...checkLinkHref(sf, allowed))
      findings.push(...checkDivAsButton(sf, allowed))
      findings.push(...checkHeadingOrder(sf, allowed))
      findings.push(...checkLangAttribute(sf, allowed))
    } catch (err) {
      process.stderr.write(`[a11y-audit] kural hatası ${file}: ${(err as Error).message}\n`)
    }
  }

  const filtered = findings.filter((f) => meetsMinSeverity(f.severity, minSeverity))
  const enriched = await enrichFindings({ findings: filtered, roleKey: "accessibility-engineer" })
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
    filesScanned: files.length,
    summary,
    byRule,
    findings: enriched.findings,
  }
}
