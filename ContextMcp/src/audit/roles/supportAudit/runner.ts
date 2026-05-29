import fs from "fs"
import path from "path"
import { CONFIG } from "../../../core/config"
import type { Finding } from "../../shared/finding"
import type { Severity } from "../../shared/severity"
import { compareSeverityDesc, meetsMinSeverity } from "../../shared/severity"
import { enrichFindings } from "../../shared/llm/enrich"

const CATEGORY = "Support"

export type SupportAuditOptions = {
  minSeverity?: Severity
}

export type SupportAuditResult = {
  scanned: { csFiles: number; exceptionClasses: number }
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

function isTestFile(relPath: string, name: string): boolean {
  const lower = name.toLowerCase()
  const relLower = relPath.toLowerCase()
  return (
    lower.endsWith("tests.cs") ||
    lower.endsWith("test.cs") ||
    relLower.includes("/tests/") ||
    relLower.includes("/test/") ||
    relLower.includes(".tests/") ||
    relLower.includes(".test/")
  )
}

const GENERIC_MESSAGES = new Set([
  "error", "failed", "fail", "wrong", "invalid", "bad", "oops",
  "exception", "problem", "issue", "unknown",
])

// throw new <Type>("message") — type ve message yakala
const THROW_NEW_RE = /\bthrow\s+new\s+([A-Z][A-Za-z0-9_.]*Exception)\s*\(\s*((?:"[^"]*"|@"[^"]*"|\$"[^"]*"))?/

function checkCrypticMessages(file: string): Finding[] {
  const out: Finding[] = []
  let text: string
  try { text = fs.readFileSync(file, "utf8") } catch { return out }
  const lines = text.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(THROW_NEW_RE)
    if (!m) continue
    const type = m[1]
    const rawMsg = m[2]

    // Untyped: type === "Exception" veya "System.Exception"
    const isUntyped = type === "Exception" || type === "System.Exception"

    // Bare: parametre yok (rawMsg undefined)
    if (!rawMsg) {
      out.push(makeFinding(
        "Medium", "bare-exception-throw",
        file, i + 1,
        `throw new ${type}() — mesaj parametresi yok.`,
        "Bare exception support team için anlamsızdır; log'da yalnız stack trace görülür, " +
        "incident triajı uzar.",
        "Anlamlı bir context mesajı ekle (kullanıcının ne yapmaya çalıştığı, hangi state). " +
        "Custom exception tipi ve ErrorCode tercih et."
      ))
      if (isUntyped) {
        out.push(makeFinding(
          "Low", "untyped-exception",
          file, i + 1,
          `Generic ${type} fırlatılıyor.`,
          "Generic exception domain bilgi taşımaz; üst katman spesifik handle edemez, " +
          "her zaman generic 500 döner.",
          "Domain-spesifik tip oluştur (örn: OrderNotFoundException : DomainException) ve " +
          "controller'da uygun HTTP status'e map et."
        ))
      }
      continue
    }

    // Mesaj string literal'i içeriden çıkar
    const msgInner = rawMsg.replace(/^["@$]+/, "").replace(/"$/, "")
    const cleaned = msgInner.trim()

    // Cryptic: çok kısa veya tek generic kelime
    const tokens = cleaned.toLowerCase().split(/\s+/).filter(Boolean)
    const isShort = cleaned.length < 20
    const isGeneric = tokens.length <= 2 && tokens.every((t) => GENERIC_MESSAGES.has(t))

    if (isShort || isGeneric) {
      out.push(makeFinding(
        "Medium", "cryptic-exception-message",
        file, i + 1,
        `throw new ${type}("${cleaned.substring(0, 40)}") — düşük kaliteli mesaj.`,
        "Cryptic mesaj support team için yardımcı değil; ek bağlam (entity, id, beklenen vs gerçek) " +
        "olmadan ticket'larda \"daha fazla bilgi gerekli\" turuna girer, çözüm süresi uzar.",
        "Anlamlı bağlam ekle: 'Order {OrderId} cannot be cancelled: status is {Status}, " +
        "expected {ExpectedStatus}'. ErrorCode field'ı ve correlation ID ile birlikte kullan."
      ))
    }

    if (isUntyped) {
      out.push(makeFinding(
        "Low", "untyped-exception",
        file, i + 1,
        `Generic ${type} fırlatılıyor.`,
        "Generic exception domain bilgi taşımaz; üst katman spesifik handle edemez, " +
        "her zaman generic 500 döner.",
        "Domain-spesifik tip oluştur (örn: OrderNotFoundException : DomainException) ve " +
        "controller'da uygun HTTP status'e map et."
      ))
    }
  }
  return out
}

// Custom exception class'ı: class XException : Exception (veya türevi)
// ErrorCode field/property var mı?
const EXCEPTION_CLASS_RE = /\bclass\s+(\w+Exception)\s*:\s*(\w+)/
const ERROR_CODE_RE = /\b(ErrorCode|Code)\b\s*(?:\{|=|;|:)/

function checkErrorCodeMissing(file: string): { findings: Finding[]; count: number } {
  const out: Finding[] = []
  let text: string
  try { text = fs.readFileSync(file, "utf8") } catch { return { findings: out, count: 0 } }
  const lines = text.split(/\r?\n/)

  let count = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(EXCEPTION_CLASS_RE)
    if (!m) continue
    count++
    const className = m[1]

    // Sınıf body içinde ErrorCode/Code field veya property var mı? — basit heuristic: aynı dosyada ara
    const hasErrorCode = ERROR_CODE_RE.test(text)
    if (!hasErrorCode) {
      out.push(makeFinding(
        "Suggestion", "error-code-missing",
        file, i + 1,
        `Custom exception '${className}' ErrorCode/Code field içermiyor.`,
        "ErrorCode olmadan support team hatayı kataloga sınıflandıramaz; localization, " +
        "müşteri-yüzlü mesaj eşleştirme ve incident kategorizasyonu yapılamaz.",
        `${className} içine public string ErrorCode { get; } ekle ve constructor'da set et. ` +
        "Kataloglaşmış kod (örn: \"ORD-404\") + lokalize edilebilir mesaj tut."
      ))
    }
  }
  return { findings: out, count }
}

export async function runSupportAudit(
  options: SupportAuditOptions = {}
): Promise<SupportAuditResult> {
  const minSeverity = options.minSeverity ?? "Low"

  const csFiles: string[] = []
  walkRepo(CONFIG.ROOT_DIR, (rel, name) => {
    if (!name.endsWith(".cs")) return false
    if (isTestFile(rel, name)) return false
    return true
  }, csFiles)

  const findings: Finding[] = []
  let exceptionClassCount = 0

  for (const file of csFiles) {
    findings.push(...checkCrypticMessages(file))
    const ec = checkErrorCodeMissing(file)
    findings.push(...ec.findings)
    exceptionClassCount += ec.count
  }

  const filtered = findings.filter((f) => meetsMinSeverity(f.severity, minSeverity))
  const enriched = await enrichFindings({ findings: filtered, roleKey: "support-engineer" })
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
    scanned: { csFiles: csFiles.length, exceptionClasses: exceptionClassCount },
    summary,
    byRule,
    findings: enriched.findings,
  }
}
