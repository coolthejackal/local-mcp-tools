import fs from "fs"
import path from "path"
import { CONFIG } from "../../../core/config"
import type { Finding } from "../../shared/finding"
import type { Severity } from "../../shared/severity"
import { compareSeverityDesc, meetsMinSeverity } from "../../shared/severity"
import { enrichFindings } from "../../shared/llm/enrich"

const CATEGORY = "Observability"

export type ObservabilityAuditOptions = {
  minSeverity?: Severity
}

export type ObservabilityAuditResult = {
  scanned: { csFiles: number; apiProjects: number }
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

// ─── 1) Logger string interpolation / concat (structured logging ihlali) ──
// Pattern: _logger.LogX($"...") veya _logger.LogX("..." + variable)
//
// Microsoft.Extensions.Logging "{Placeholder}" formatını yapısal indeksleme için
// kullanır. Interpolation/concat yapısal alanları kaybeder; log aggregator
// (Seq/Loki/Splunk) içinde filter/query yapılamaz.

const LOGGER_METHODS = ["LogTrace", "LogDebug", "LogInformation", "LogWarning", "LogError", "LogCritical"]
const LOGGER_PATTERN = new RegExp(`\\b(_?logger|_?log)\\.(${LOGGER_METHODS.join("|")})\\s*\\(`)

function checkLoggerInterpolation(file: string): Finding[] {
  const out: Finding[] = []
  let text: string
  try { text = fs.readFileSync(file, "utf8") } catch { return out }
  const lines = text.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!LOGGER_PATTERN.test(line)) continue

    // Interpolated string: _logger.LogX($"...")
    const hasInterpolation = /\.(?:LogTrace|LogDebug|LogInformation|LogWarning|LogError|LogCritical)\s*\(\s*\$/.test(line)
    // String concat: _logger.LogX("..." + x) veya _logger.LogX("..." + ... + ...)
    // Sadece logger satırının başlangıcı ile aynı satırda concat operatörü
    const hasConcat = /\.(?:LogTrace|LogDebug|LogInformation|LogWarning|LogError|LogCritical)\s*\([^)]*"[^"]*"\s*\+/.test(line)

    if (hasInterpolation) {
      out.push(makeFinding(
        "Medium", "log-string-interpolation",
        file, i + 1,
        "Logger çağrısı interpolated string ($\"\") kullanıyor.",
        "Interpolation yapılandırılmış log alanlarını kaybeder; log aggregator " +
        "(Seq/Loki/Splunk/ELK) içinde {UserId} gibi alanlar üzerinden filter/query " +
        "yapılamaz. Performans da düşer (her log için string allocation).",
        "Structured format kullan: _logger.LogInformation(\"User {UserId} did X\", userId); " +
        "Placeholder PascalCase tercih edilir, indeksleme tutarlı olur."
      ))
    } else if (hasConcat) {
      out.push(makeFinding(
        "Medium", "log-string-concat",
        file, i + 1,
        "Logger çağrısı string concatenation (+) kullanıyor.",
        "Concat yapılandırılmış alanları kaybeder, log aggregator'larda filtreleme yapılamaz; " +
        "ayrıca allocation maliyeti vardır.",
        "Placeholder formatına geç: _logger.LogX(\"... {Field} ...\", value)."
      ))
    }
  }
  return out
}

// ─── 2,3,4) Program.cs / Startup.cs project-level kontroller ──────────────
// API project işaretleri (herhangi biri yeterli):
//   - WebApplication.CreateBuilder (Minimal API / .NET 6+ host)
//   - UseEndpoints / UseRouting / MapControllers (klasik MVC)
//   - app.MapGet/Post/... direkt çağrı (Minimal API direkt)
//   - app.MapXxxEndpoints() extension method pattern (route grouping)
const API_PROJECT_SIGNALS = [
  /\bWebApplication\.CreateBuilder\b/,
  /\bWebApplicationBuilder\b/,
  /\bapp\.UseEndpoints\s*\(/,
  /\bapp\.UseRouting\s*\(/,
  /\bapp\.MapControllers\s*\(/,
  /\bapp\.Map(Get|Post|Put|Delete|Patch|Group)\s*\(/,
  /\bapp\.Map[A-Z]\w*Endpoints?\s*\(/,
]

function isApiProject(text: string): boolean {
  return API_PROJECT_SIGNALS.some((re) => re.test(text))
}

function checkProgramCs(file: string): Finding[] {
  const out: Finding[] = []
  let text: string
  try { text = fs.readFileSync(file, "utf8") } catch { return out }
  if (!isApiProject(text)) return out

  const lines = text.split(/\r?\n/)
  const lineOf = (needle: RegExp): number => {
    const i = lines.findIndex((l) => needle.test(l))
    return i >= 0 ? i + 1 : 1
  }

  // Correlation ID — yaygın pattern'ler:
  //   app.UseMiddleware<CorrelationIdMiddleware>()
  //   app.UseCorrelationId()
  //   builder.Services.AddCorrelationId() (Hellang.Middleware.Spid CorrelationId)
  //   app.Use((context, next) => ... TraceIdentifier ...) - manual
  const hasCorrelation =
    /\bUseMiddleware\s*<\s*\w*Correlation\w*\s*>/.test(text) ||
    /\bUseCorrelationId\s*\(/.test(text) ||
    /\bAddCorrelationId\s*\(/.test(text) ||
    /\bTraceIdentifier\b/.test(text) ||
    /X-Correlation-Id/i.test(text)
  if (!hasCorrelation) {
    out.push(makeFinding(
      "Medium", "missing-correlation-id",
      file, lineOf(/\bUseRouting|\bUseEndpoints|\bMapControllers|\bMapGet/),
      "Program.cs'de correlation ID middleware görünmüyor.",
      "Correlation ID olmadan microservice çağrıları arasında bir request'i takip etmek " +
      "imkansızdır; production'da incident root cause analizi çok zaman alır.",
      "Hellang.Middleware.Correlation, custom UseMiddleware<CorrelationIdMiddleware>, " +
      "veya OpenTelemetry trace ID propagation. X-Correlation-Id header'ını gelen istek'ten " +
      "al, yoksa üret, response'ta geri ekle, log scope'una koy."
    ))
  }

  // HealthCheck endpoint
  const hasHealthCheck =
    /\bAddHealthChecks\s*\(/.test(text) ||
    /\bMapHealthChecks\s*\(/.test(text)
  if (!hasHealthCheck) {
    out.push(makeFinding(
      "Low", "missing-healthcheck",
      file, lineOf(/\bMapControllers|\bMapGet|\bUseEndpoints/),
      "Program.cs'de health check endpoint görünmüyor.",
      "Orchestrator (K8s/compose) ve load balancer servisin sağlığını bilemez; " +
      "döngüsel restart, hatalı routing, gerçek hata maskelenmesi olabilir.",
      "builder.Services.AddHealthChecks() + app.MapHealthChecks(\"/health\"). " +
      "DB/cache/external bağımlılıklar için AspNetCore.HealthChecks paketleri (Sql, Redis, vb.)."
    ))
  }

  // OpenTelemetry / distributed tracing
  const hasOtel =
    /\bAddOpenTelemetry\s*\(/.test(text) ||
    /\bWithTracing\s*\(/.test(text) ||
    /\bWithMetrics\s*\(/.test(text) ||
    /\bnew\s+ActivitySource\b/.test(text) ||
    /\bUseOpenTelemetry/i.test(text)
  if (!hasOtel) {
    out.push(makeFinding(
      "Suggestion", "missing-otel",
      file, 1,
      "Program.cs'de OpenTelemetry / distributed tracing instrumentation yok.",
      "Mikroservis topolojisinde end-to-end trace olmadan latency analizi ve " +
      "bağımlılık etkisi izlemek imkansız; performans regresyonları geç fark edilir.",
      "OpenTelemetry.Extensions.Hosting + WithTracing(AspNetCore + HttpClient + " +
      "EntityFrameworkCore instrumentation) + OTLP exporter. Activity source ekle: " +
      "static readonly ActivitySource Source = new(\"MyService\")."
    ))
  }

  return out
}

// ─── 5) PII in logs (heuristic) ────────────────────────────────────────────
const PII_KEYWORDS = ["password", "passwd", "pwd", "ssn", "creditcard", "cvv", "tckn"]
const PII_PATTERN = new RegExp(
  `\\b(?:_?logger|_?log)\\.(?:Log[A-Z]\\w+)\\s*\\([^)]*\\b(${PII_KEYWORDS.join("|")})\\b`,
  "i"
)

function checkPiiInLog(file: string): Finding[] {
  const out: Finding[] = []
  let text: string
  try { text = fs.readFileSync(file, "utf8") } catch { return out }
  const lines = text.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    if (!PII_PATTERN.test(lines[i])) continue
    const match = lines[i].match(PII_PATTERN)
    out.push(makeFinding(
      "High", "pii-in-log",
      file, i + 1,
      `Logger çağrısı PII alan adı (${match?.[1] ?? "unknown"}) içeriyor.`,
      "PII'ı log'a yazmak GDPR/CCPA ihlali olabilir. Log aggregator'larda " +
      "compliance kapsamında uzun süre tutulur; sızıntı durumunda regulatory bildirim gerekir.",
      "Hassas alanları log'dan çıkar veya hash/mask edilmiş versiyonu kullan " +
      "(örn: email → e***@d***.com). Structured logging için scrub middleware veya " +
      "log filter yaz."
    ))
  }
  return out
}

// ─── Orchestrator ─────────────────────────────────────────────────────────
export async function runObservabilityAudit(
  options: ObservabilityAuditOptions = {}
): Promise<ObservabilityAuditResult> {
  const minSeverity = options.minSeverity ?? "Low"

  const csFiles: string[] = []
  walkRepo(CONFIG.ROOT_DIR, (_rel, name) => name.endsWith(".cs"), csFiles)

  const programCsFiles: string[] = []
  walkRepo(
    CONFIG.ROOT_DIR,
    (_rel, name) => name === "Program.cs" || name === "Startup.cs",
    programCsFiles
  )

  // API project sayısı (Program.cs içeriği API işareti veriyorsa)
  let apiProjects = 0
  for (const f of programCsFiles) {
    try {
      const t = fs.readFileSync(f, "utf8")
      if (isApiProject(t)) apiProjects++
    } catch { /* skip */ }
  }

  const findings: Finding[] = []

  // Logger interpolation/concat (her .cs dosyası)
  for (const f of csFiles) findings.push(...checkLoggerInterpolation(f))
  // PII in log (her .cs dosyası)
  for (const f of csFiles) findings.push(...checkPiiInLog(f))
  // Program.cs project-level kontroller
  for (const f of programCsFiles) findings.push(...checkProgramCs(f))

  const filtered = findings.filter((f) => meetsMinSeverity(f.severity, minSeverity))
  const enriched = await enrichFindings({
    findings: filtered,
    roleKey: "observability-engineer",
  })
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
    scanned: { csFiles: csFiles.length, apiProjects },
    summary,
    byRule,
    findings: enriched.findings,
  }
}
