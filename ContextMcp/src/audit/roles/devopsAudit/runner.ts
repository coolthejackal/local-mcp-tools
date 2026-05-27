import fs from "fs"
import path from "path"
import { CONFIG } from "../../../core/config"
import type { Finding } from "../../shared/finding"
import type { Severity } from "../../shared/severity"
import { compareSeverityDesc, meetsMinSeverity } from "../../shared/severity"
import { enrichFindings } from "../../shared/llm/enrich"

const CATEGORY = "DevOps"

// Hardcoded secret pattern'leri (review/securityRules ile aynı set — repo geneline yansıtılıyor)
const SECRET_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /AKIA[0-9A-Z]{16}/, label: "AWS access key" },
  { regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, label: "private key (PEM)" },
  { regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, label: "JWT token" },
  { regex: /(?:PASSWORD|PASSWD|API[_-]?KEY|SECRET|TOKEN)\s*=\s*[^$#\s].{5,}/i, label: "credential literal" },
]

export type DevOpsAuditOptions = {
  minSeverity?: Severity
}

export type DevOpsAuditResult = {
  filesScanned: number
  summary: Record<Lowercase<Severity>, number>
  byRule: Record<string, number>
  findings: Finding[]
}

function findFiles(predicate: (relPath: string, name: string) => boolean): string[] {
  const out: string[] = []
  function visit(dir: string): void {
    let items: fs.Dirent[]
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      const full = path.join(dir, it.name)
      const rel = path.relative(CONFIG.ROOT_DIR, full).replace(/\\/g, "/")
      if (it.isDirectory()) {
        if (rel.split("/").some((seg) => CONFIG.EXCLUDED_DIRS.includes(seg))) continue
        visit(full)
      } else if (predicate(rel, it.name)) {
        out.push(full)
      }
    }
  }
  visit(CONFIG.ROOT_DIR)
  return out
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

// ─── Dockerfile ─────────────────────────────────────────────────────────────
function auditDockerfile(file: string): Finding[] {
  const out: Finding[] = []
  let text: string
  try { text = fs.readFileSync(file, "utf8") } catch { return out }
  const lines = text.split(/\r?\n/)

  let stageCount = 0
  let hasUser = false
  let userIsRoot = false

  lines.forEach((rawLine, idx) => {
    const lineNum = idx + 1
    const line = rawLine.trim()
    if (line.startsWith("#") || line.length === 0) return
    const upper = line.toUpperCase()
    if (upper.startsWith("FROM ")) stageCount++
    if (upper.startsWith("USER ")) {
      hasUser = true
      const userName = line.substring(5).trim()
      if (userName === "root" || userName === "0") userIsRoot = true
    }

    // Secret leak (DOCKER ENV)
    if (upper.startsWith("ENV ") || upper.startsWith("ARG ")) {
      for (const { regex, label } of SECRET_PATTERNS) {
        if (regex.test(line)) {
          out.push(makeFinding(
            "Critical",
            "secret-in-dockerfile",
            file, lineNum,
            `Dockerfile içinde olası ${label}.`,
            "Image içine gömülen sırlar registry'ye basılır ve geri alınamaz; layer history " +
            "üzerinden okunabilir.",
            "Build-arg yerine runtime secret kullan (Docker --secret, K8s Secret, " +
            "AWS Secrets Manager). Sırları image'a embed etme."
          ))
          break
        }
      }
    }
  })

  if (stageCount < 2) {
    out.push(makeFinding(
      "Low",
      "no-multi-stage-build",
      file, 1,
      "Dockerfile tek FROM (multi-stage build yok).",
      "Tek-aşama build'lerde derleyici/SDK runtime image'a sızar; image büyür, " +
      "saldırı yüzeyi artar.",
      "Builder + runtime için ayrı stage kullan: " +
      "FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build / FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS final."
    ))
  }

  if (!hasUser || userIsRoot) {
    out.push(makeFinding(
      "High",
      "container-runs-as-root",
      file, 1,
      "Dockerfile USER tanımı yok veya root olarak çalışıyor.",
      "Root container kompromise olursa host'a yatay hareket riski artar; " +
      "K8s pod security policy ihlali olur.",
      "USER 1000:1000 (veya isimli non-root user) ile devam et. " +
      "Gerekiyorsa runtime stage başında: RUN adduser --uid 1000 app && USER app."
    ))
  }

  return out
}

// ─── docker-compose.yml ─────────────────────────────────────────────────────
function auditDockerCompose(file: string): Finding[] {
  const out: Finding[] = []
  let text: string
  try { text = fs.readFileSync(file, "utf8") } catch { return out }
  const lines = text.split(/\r?\n/)

  // Çok basit YAML pattern matching — saatte bir kez kullanılacak araç için yeterli.
  let currentService: string | null = null
  let currentServiceLine = 0
  let serviceHasHealthcheck = false
  const services: Array<{ name: string; line: number; healthcheck: boolean }> = []

  lines.forEach((rawLine, idx) => {
    const lineNum = idx + 1
    const m = rawLine.match(/^  ([a-zA-Z0-9_-]+):\s*$/)
    if (m) {
      if (currentService) {
        services.push({ name: currentService, line: currentServiceLine, healthcheck: serviceHasHealthcheck })
      }
      currentService = m[1]
      currentServiceLine = lineNum
      serviceHasHealthcheck = false
      return
    }
    if (/^\s+healthcheck:/.test(rawLine)) serviceHasHealthcheck = true

    // Secret patterns (raw value in environment:)
    if (/^\s*-\s*[A-Z_]+=/.test(rawLine) || /^\s+[A-Z_]+:\s*\S/.test(rawLine)) {
      for (const { regex, label } of SECRET_PATTERNS) {
        if (regex.test(rawLine)) {
          out.push(makeFinding(
            "Critical",
            "secret-in-compose",
            file, lineNum,
            `docker-compose içinde olası ${label}.`,
            "Compose dosyaları repo'ya commit edilir; sır git history'de kalıcı olur.",
            "Sırları .env dosyasına taşı ve compose'da ${VAR_NAME} referansıyla kullan. " +
            ".env dosyası gitignore'da olmalı."
          ))
          break
        }
      }
    }
  })
  if (currentService) {
    services.push({ name: currentService, line: currentServiceLine, healthcheck: serviceHasHealthcheck })
  }

  for (const s of services) {
    if (!s.healthcheck) {
      out.push(makeFinding(
        "Medium",
        "service-no-healthcheck",
        file, s.line,
        `Servis '${s.name}' healthcheck tanımı yok.`,
        "Healthcheck olmadan orchestrator (compose/K8s) servisin gerçek durumunu bilmez; " +
        "döngüsel restart ya da yanlış routing yapabilir.",
        "healthcheck: { test, interval, timeout, retries } ekle. HTTP servisi için " +
        "wget/curl ile /health endpoint'ini probe et."
      ))
    }
  }

  return out
}

// ─── .env dosyaları ─────────────────────────────────────────────────────────
function auditEnvFile(file: string): Finding[] {
  const out: Finding[] = []
  // .env.example güvenlidir — dökümante şablonu
  if (path.basename(file).toLowerCase() === ".env.example") return out
  let text: string
  try { text = fs.readFileSync(file, "utf8") } catch { return out }
  const lines = text.split(/\r?\n/)

  lines.forEach((rawLine, idx) => {
    if (rawLine.trim().startsWith("#") || rawLine.trim().length === 0) return
    for (const { regex, label } of SECRET_PATTERNS) {
      if (regex.test(rawLine)) {
        out.push(makeFinding(
          "High",
          "env-file-secret",
          file, idx + 1,
          `'${path.basename(file)}' içinde olası ${label}.`,
          ".env dosyası gitignore'da olsa bile local-machine sızıntısı riski var; " +
          "repo'ya commit edilirse rotation gerekir.",
          "Üretim sırları için secret manager kullan (Vault, AWS SM, K8s Secret). " +
          ".env yalnız dev için ve gitignore'da olmalı."
        ))
        break
      }
    }
  })
  return out
}

// ─── CI workflows ──────────────────────────────────────────────────────────
function auditCiWorkflow(file: string): Finding[] {
  const out: Finding[] = []
  let text: string
  try { text = fs.readFileSync(file, "utf8") } catch { return out }
  const lines = text.split(/\r?\n/)

  let usesActionsCheckout = false
  let hasCache = false
  let runsOnSelfHosted = false

  lines.forEach((rawLine, idx) => {
    if (/actions\/checkout@/.test(rawLine)) usesActionsCheckout = true
    if (/actions\/cache@|cache:\s*true/.test(rawLine)) hasCache = true
    if (/runs-on:\s*self-hosted/.test(rawLine)) runsOnSelfHosted = true
    for (const { regex, label } of SECRET_PATTERNS) {
      if (regex.test(rawLine)) {
        out.push(makeFinding(
          "Critical",
          "secret-in-ci-workflow",
          file, idx + 1,
          `CI workflow içinde olası ${label}.`,
          "Workflow dosyaları repo'da, sır leak'i public/private repo fark etmez; rotation şart.",
          "Sırları GitHub Secrets / GitLab CI Variables'a taşı, ${{ secrets.NAME }} ile referansla."
        ))
      }
    }
  })

  if (usesActionsCheckout && !hasCache && /package\.json|\.csproj/.test(text)) {
    out.push(makeFinding(
      "Low",
      "ci-no-dependency-cache",
      file, 1,
      "Workflow bağımlılık cache'i yok (actions/cache veya cache: true).",
      "Cache olmadan her run dependency'leri yeniden indirir — CI süresi ve GH Actions " +
      "minute consumption artar.",
      "actions/setup-node@v4 cache: 'npm' veya actions/cache@v4 ile node_modules/nuget " +
      "cache'i etkinleştir."
    ))
  }

  if (runsOnSelfHosted) {
    out.push(makeFinding(
      "Medium",
      "ci-self-hosted-runner",
      file, 1,
      "Workflow self-hosted runner kullanıyor.",
      "Public repo için self-hosted runner güvenlik riski (PR'lar arbitrary kod çalıştırabilir). " +
      "Private repo için bile izolasyon ve patching ekibe yük getirir.",
      "Mümkünse GitHub-hosted runner kullan; self-hosted gerekirse ephemeral container " +
      "veya VM ile yalıtılmış havuz tut."
    ))
  }

  return out
}

export async function runDevOpsAudit(options: DevOpsAuditOptions = {}): Promise<DevOpsAuditResult> {
  const minSeverity = options.minSeverity ?? "Low"

  const dockerfiles = findFiles((_rel, name) => /^Dockerfile/i.test(name))
  const composeFiles = findFiles((_rel, name) => /^docker-compose.*\.ya?ml$/i.test(name))
  const envFiles = findFiles((_rel, name) => /^\.env(\.|$)/i.test(name) && !/\.env\.example$/i.test(name))
  const ciFiles = findFiles((rel, name) => /\.ya?ml$/i.test(name) &&
    (rel.startsWith(".github/workflows/") || rel.includes("/.github/workflows/")))

  const findings: Finding[] = []
  for (const f of dockerfiles) findings.push(...auditDockerfile(f))
  for (const f of composeFiles) findings.push(...auditDockerCompose(f))
  for (const f of envFiles) findings.push(...auditEnvFile(f))
  for (const f of ciFiles) findings.push(...auditCiWorkflow(f))

  const filtered = findings.filter((f) => meetsMinSeverity(f.severity, minSeverity))
  const enriched = await enrichFindings({ findings: filtered, roleKey: "devops-engineer" })
  enriched.findings.sort((a, b) => compareSeverityDesc(a.severity, b.severity) || a.file.localeCompare(b.file) || a.line - b.line)

  const summary: Record<Lowercase<Severity>, number> = {
    critical: 0, high: 0, medium: 0, low: 0, suggestion: 0,
  }
  const byRule: Record<string, number> = {}
  for (const f of enriched.findings) {
    summary[f.severity.toLowerCase() as Lowercase<Severity>]++
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1
  }

  return {
    filesScanned: dockerfiles.length + composeFiles.length + envFiles.length + ciFiles.length,
    summary,
    byRule,
    findings: enriched.findings,
  }
}
