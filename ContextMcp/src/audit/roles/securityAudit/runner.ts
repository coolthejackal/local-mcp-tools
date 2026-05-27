import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"
import { CONFIG } from "../../../core/config"
import type { Finding } from "../../shared/finding"
import type { Severity } from "../../shared/severity"
import { compareSeverityDesc, meetsMinSeverity } from "../../shared/severity"
import { enrichFindings } from "../../shared/llm/enrich"

const CATEGORY = "Security"

// review/rules/securityRules.ts ile aynı pattern seti — repo geneline yansıtılır.
// (review query-driven; security_audit tüm CTX_ROOT'ta — kasıtlı duplication değil,
// devops_audit ve review aynı kategorinin farklı kapsamlarını işler.)
const SECRET_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /AKIA[0-9A-Z]{16}/, label: "AWS access key" },
  { regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, label: "private key (PEM)" },
  { regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, label: "JWT token" },
  { regex: /(?:password|passwd|pwd|api[_-]?key|secret|token)\s*[:=]\s*['"][^'"\s]{6,}['"]/i, label: "credential literal" },
  { regex: /(?:mongodb|postgres|postgresql|mysql|mssql|redis):\/\/[^\s'"<>]+:[^\s'"<>]+@/i, label: "DB connection string with credentials" },
]

export type SecurityAuditOptions = {
  minSeverity?: Severity
  skipDependencyScan?: boolean  // npm audit / dotnet list package CI yokken yavaş olabilir
}

export type SecurityAuditResult = {
  scanned: { configFiles: number; manifestFiles: number; secretsCandidates: number }
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

// ─── 1) Repo-wide secret scan ───────────────────────────────────────────────
// devops_audit Dockerfile/compose/.env/CI yml dosyalarını tarıyor.
// security_audit ise application config + docs + JSON/YAML config'lerini tarar.
// Çakışmayı önlemek için devops_audit'in zaten taradığı dosya tiplerini hariç tutarız.
function scanSecrets(): { files: number; findings: Finding[] } {
  const findings: Finding[] = []
  const files: string[] = []

  walkRepo(CONFIG.ROOT_DIR, (rel, name) => {
    const lower = name.toLowerCase()
    // devops_audit kapsamı — hariç tut
    if (/^dockerfile/i.test(name)) return false
    if (/^docker-compose.*\.ya?ml$/i.test(name)) return false
    if (/^\.env(\.|$)/i.test(name) && !/\.env\.example$/i.test(name)) return false
    if (rel.includes(".github/workflows/") && /\.ya?ml$/i.test(name)) return false
    // security_audit kapsamı: text config dosyaları
    return (
      lower.endsWith(".json") ||
      lower.endsWith(".yml") ||
      lower.endsWith(".yaml") ||
      lower.endsWith(".config") ||
      lower.endsWith(".xml") ||
      lower.endsWith(".properties") ||
      lower.endsWith(".ini") ||
      lower.endsWith(".toml") ||
      lower === "appsettings.json" ||
      /^appsettings\.[a-z]+\.json$/i.test(name)
    )
  }, files)

  for (const file of files) {
    let text: string
    try {
      const stat = fs.statSync(file)
      if (stat.size > 500_000) continue
      text = fs.readFileSync(file, "utf8")
    } catch { continue }
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      for (const { regex, label } of SECRET_PATTERNS) {
        if (regex.test(lines[i])) {
          findings.push(makeFinding(
            "Critical",
            "config-file-secret",
            file, i + 1,
            `Olası ${label} config dosyasında.`,
            "Config dosyalarına commit edilen sırlar git history'de kalır; rotation gerekir.",
            "Sırı secret manager'a taşı (User Secrets, Azure Key Vault, AWS Secrets Manager). " +
            "Production config'lerinde sır barındırma, environment variable veya runtime injection kullan."
          ))
          break
        }
      }
    }
  }
  return { files: files.length, findings }
}

// ─── 2) Dependency CVE scan ─────────────────────────────────────────────────
function scanDependencies(skip: boolean): { manifestFiles: number; findings: Finding[] } {
  const findings: Finding[] = []
  if (skip) return { manifestFiles: 0, findings }

  const pkgJsons: string[] = []
  walkRepo(CONFIG.ROOT_DIR, (rel, name) => name === "package.json" && !rel.includes("node_modules/"), pkgJsons)
  const csprojFiles: string[] = []
  walkRepo(CONFIG.ROOT_DIR, (_rel, name) => name.endsWith(".csproj"), csprojFiles)
  for (const pkg of pkgJsons) {
    const dir = path.dirname(pkg)
    if (!fs.existsSync(path.join(dir, "package-lock.json"))) continue  // lockfile şart
    try {
      const stdout = execFileSync("npm", ["audit", "--json"], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      const audit = JSON.parse(stdout) as {
        vulnerabilities?: Record<string, {
          severity: "low" | "moderate" | "high" | "critical"
          via?: Array<{ title?: string; url?: string } | string>
        }>
      }
      const vulns = audit.vulnerabilities ?? {}
      for (const [pkgName, info] of Object.entries(vulns)) {
        const sevMap: Record<string, Finding["severity"]> = {
          critical: "Critical", high: "High", moderate: "Medium", low: "Low",
        }
        const via = (info.via ?? []).find((v) => typeof v === "object" && v.title) as { title?: string; url?: string } | undefined
        findings.push(makeFinding(
          sevMap[info.severity] ?? "Medium",
          "dependency-cve",
          pkg, 1,
          `npm dependency '${pkgName}' has ${info.severity} severity vulnerability` + (via?.title ? `: ${via.title}` : "."),
          "Bilinen CVE'li bağımlılık production'da exploit edilebilir; transitive bağımlılıklar dahil saldırı yüzeyi geniş.",
          `Çözüm için: cd ${path.dirname(pkg)} && npm audit fix. Breaking change varsa npm audit fix --force ` +
          "ve regresyon testi gerekir. Manuel inceleme için 'npm audit' çıktısını oku."
        ))
      }
    } catch (err) {
      process.stderr.write(`[security-audit] npm audit başarısız (${dir}): ${(err as Error).message.split("\n")[0]}\n`)
    }
  }

  // dotnet list package --vulnerable
  // Solution dosyası ya da en üst seviye proje
  if (csprojFiles.length > 0) {
    const slnFiles: string[] = []
    walkRepo(CONFIG.ROOT_DIR, (_rel, name) => name.endsWith(".sln"), slnFiles)
    const target = slnFiles[0] ?? csprojFiles[0]
    if (target) {
      try {
        const stdout = execFileSync(
          "dotnet",
          ["list", target, "package", "--vulnerable", "--include-transitive", "--format", "json"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
        )
        const parsed = JSON.parse(stdout) as {
          projects?: Array<{
            path: string
            frameworks?: Array<{
              topLevelPackages?: Array<{ id: string; resolvedVersion: string; vulnerabilities?: Array<{ severity: string; advisoryurl?: string }> }>
              transitivePackages?: Array<{ id: string; resolvedVersion: string; vulnerabilities?: Array<{ severity: string; advisoryurl?: string }> }>
            }>
          }>
        }
        for (const proj of parsed.projects ?? []) {
          for (const fw of proj.frameworks ?? []) {
            const all = [...(fw.topLevelPackages ?? []), ...(fw.transitivePackages ?? [])]
            for (const pkg of all) {
              for (const vuln of pkg.vulnerabilities ?? []) {
                const sevMap: Record<string, Finding["severity"]> = {
                  Critical: "Critical", High: "High", Moderate: "Medium", Low: "Low",
                }
                findings.push(makeFinding(
                  sevMap[vuln.severity] ?? "Medium",
                  "dependency-cve",
                  proj.path, 1,
                  `NuGet '${pkg.id}@${pkg.resolvedVersion}' ${vuln.severity.toLowerCase()} severity zafiyet içeriyor.`,
                  "CVE'li NuGet paketi tüm bağımlı projelere yayılır; production'da exploit riski.",
                  `Daha yeni sürüm var mı kontrol et (dotnet add package ${pkg.id}). ` +
                  (vuln.advisoryurl ? `Advisory: ${vuln.advisoryurl}` : "")
                ))
              }
            }
          }
        }
      } catch (err) {
        process.stderr.write(`[security-audit] dotnet list --vulnerable başarısız: ${(err as Error).message.split("\n")[0]}\n`)
      }
    }
  }

  return { manifestFiles: pkgJsons.length + csprojFiles.length, findings }
}

// ─── 3) HTTP security headers + CORS (Program.cs / Startup.cs text scan) ───
function scanHttpSecurity(): Finding[] {
  const findings: Finding[] = []
  const files: string[] = []
  walkRepo(CONFIG.ROOT_DIR, (_rel, name) => name === "Program.cs" || name === "Startup.cs", files)

  for (const file of files) {
    let text: string
    try { text = fs.readFileSync(file, "utf8") } catch { continue }

    const lines = text.split(/\r?\n/)
    const lineOf = (needle: string): number => {
      const i = lines.findIndex((l) => l.includes(needle))
      return i >= 0 ? i + 1 : 1
    }

    const hasUseHsts = /\bapp\.UseHsts\s*\(/.test(text)
    const hasUseHttpsRedirect = /\bapp\.UseHttpsRedirection\s*\(/.test(text)
    const hasUseCors = /\bapp\.UseCors\s*\(/.test(text)
    const hasAllowAnyOriginWithCredentials =
      /AllowAnyOrigin\s*\(\s*\)/.test(text) && /AllowCredentials\s*\(\s*\)/.test(text)

    // Mücadele: aspnet core minimal API + WebApplicationBuilder pattern'inde IsDevelopment kontrolü var
    const probableProductionPath = /Environment\.IsProduction|app\.Environment\.IsDevelopment|builder\.Environment/.test(text)

    if (!hasUseHsts && probableProductionPath) {
      findings.push(makeFinding(
        "High",
        "missing-hsts",
        file, lineOf("var app"),
        "Program.cs'de UseHsts() çağrısı yok.",
        "HSTS olmadan kullanıcı tarayıcı sertifika hatasında HTTPS'i bypass edebilir. " +
        "MITM saldırılarına açıklık production ortamında ciddi risk.",
        "Production branch'inde app.UseHsts() ekle. HstsOptions ile MaxAge ve Subdomains ayarla."
      ))
    }
    if (!hasUseHttpsRedirect) {
      findings.push(makeFinding(
        "Medium",
        "missing-https-redirect",
        file, lineOf("var app"),
        "Program.cs'de UseHttpsRedirection() çağrısı yok.",
        "HTTP isteklerinin HTTPS'e yönlendirilmemesi sırların plaintext gitmesine yol açar.",
        "app.UseHttpsRedirection() ekle. Reverse proxy arkasında ise proxy yapılandırmasını kontrol et."
      ))
    }
    if (hasUseCors && hasAllowAnyOriginWithCredentials) {
      findings.push(makeFinding(
        "Critical",
        "cors-any-origin-with-credentials",
        file, lineOf("AllowAnyOrigin"),
        "CORS yapılandırması AllowAnyOrigin() ile AllowCredentials() birlikte kullanılıyor.",
        "CSRF saldırılarına karşı korumayı tamamen devre dışı bırakır; herhangi bir origin " +
        "kullanıcı oturumu ile istek yapabilir. CORS spec bunu yasaklasa da bazı sürümlerde " +
        "uygulanıyor.",
        "WithOrigins(\"https://known-origin\") ile beyaz liste kullan. Geliştirme için " +
        "ayrı policy tanımla."
      ))
    }
  }

  return findings
}

// ─── 4) Cookie + Auth/session config (Program.cs + appsettings) ────────────
function scanAuthConfig(): Finding[] {
  const findings: Finding[] = []
  const programFiles: string[] = []
  walkRepo(CONFIG.ROOT_DIR, (_rel, name) => name === "Program.cs" || name === "Startup.cs", programFiles)
  const appsettings: string[] = []
  walkRepo(CONFIG.ROOT_DIR, (_rel, name) => /^appsettings(\..+)?\.json$/i.test(name), appsettings)

  // Program.cs: cookie attribute sniff
  for (const file of programFiles) {
    let text: string
    try { text = fs.readFileSync(file, "utf8") } catch { continue }

    if (/\.AddCookie\s*\(/.test(text) || /\.ConfigureApplicationCookie\s*\(/.test(text)) {
      const hasSameSite = /\bSameSite\s*=\s*(?:SameSiteMode\.)?(?:Strict|Lax)\b/.test(text)
      const hasSecure = /\bSecurePolicy\s*=\s*(?:CookieSecurePolicy\.)?Always\b/.test(text) || /\bSecure\s*=\s*true\b/.test(text)
      const hasHttpOnly = /\bHttpOnly\s*=\s*true\b/.test(text)
      if (!hasSameSite) {
        findings.push(makeFinding(
          "High", "cookie-missing-samesite", file, 1,
          "Authentication cookie SameSite attribute tanımlı değil.",
          "SameSite olmadan CSRF saldırılarına açık kalır; üçüncü taraf sitelerden cookie gönderilebilir.",
          "options.Cookie.SameSite = SameSiteMode.Lax (varsayılan) veya Strict olarak ayarla."
        ))
      }
      if (!hasSecure) {
        findings.push(makeFinding(
          "High", "cookie-missing-secure", file, 1,
          "Authentication cookie Secure / SecurePolicy=Always tanımlı değil.",
          "HTTP üzerinden cookie gönderilebilir, MITM saldırılarına açık.",
          "options.Cookie.SecurePolicy = CookieSecurePolicy.Always (production'da)."
        ))
      }
      if (!hasHttpOnly) {
        findings.push(makeFinding(
          "Medium", "cookie-missing-httponly", file, 1,
          "Authentication cookie HttpOnly tanımlı değil.",
          "XSS açığı varsa client-side JavaScript cookie'ye erişebilir, session theft riski.",
          "options.Cookie.HttpOnly = true."
        ))
      }
    }

    // Password policy heuristic (Identity options)
    if (/AddIdentity|AddDefaultIdentity/.test(text)) {
      const reqLen = text.match(/Password\.RequiredLength\s*=\s*(\d+)/)
      if (reqLen && parseInt(reqLen[1], 10) < 8) {
        findings.push(makeFinding(
          "High", "password-policy-weak", file, 1,
          `Password.RequiredLength=${reqLen[1]} (< 8 zayıf).`,
          "8 karakterden az şifreler kaba kuvvet saldırılarına açık.",
          "options.Password.RequiredLength = 12 (öneri). Ek olarak RequireUppercase, " +
          "RequireDigit, RequireNonAlphanumeric kullan."
        ))
      }
    }
  }

  // appsettings.json: JWT lifetime ve diğer config
  for (const file of appsettings) {
    let text: string
    try { text = fs.readFileSync(file, "utf8") } catch { continue }
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { continue }
    const obj = parsed as Record<string, unknown>

    // JWT lifetime kontrol
    const jwt = (obj.Jwt ?? obj.JwtSettings ?? obj.Authentication) as Record<string, unknown> | undefined
    if (jwt) {
      const lifetimeMin = Number(jwt.ExpirationMinutes ?? jwt.LifetimeMinutes ?? jwt.AccessTokenLifetimeMinutes)
      if (!isNaN(lifetimeMin) && lifetimeMin > 60) {
        findings.push(makeFinding(
          "Medium", "jwt-lifetime-too-long", file, 1,
          `JWT lifetime ${lifetimeMin} dakika (>60 dk).`,
          "Uzun ömürlü JWT çalındığında uzun süre kötüye kullanılabilir; refresh token " +
          "ile birlikte 15-60 dakika önerilir.",
          "AccessTokenLifetime'ı 15-30 dakikaya indir, RefreshToken pattern kullan."
        ))
      }
      // İmza algoritması — HS256 paylaşılan secret riski
      const algo = jwt.Algorithm as string | undefined
      if (typeof algo === "string" && algo.toUpperCase().startsWith("HS")) {
        findings.push(makeFinding(
          "Low", "jwt-symmetric-algorithm", file, 1,
          `JWT algoritması ${algo} (symmetric).`,
          "Symmetric algoritmalar paylaşılan sırrı her doğrulayıcıda gerektirir; mikroservis " +
          "topolojisinde sır sızıntısı tüm sistemi etkiler.",
          "Asymmetric algoritmalar tercih et (RS256 / ES256). Public key servislere dağıtılır, " +
          "private key tek noktada kalır."
        ))
      }
    }
  }

  return findings
}

// ─── 5) License compatibility (MVP) ────────────────────────────────────────
const COPYLEFT_LICENSES = new Set([
  "GPL-1.0", "GPL-2.0", "GPL-3.0", "AGPL-1.0", "AGPL-3.0", "LGPL-2.0", "LGPL-2.1", "LGPL-3.0",
  "GPL-2.0-only", "GPL-3.0-only", "GPL-2.0-or-later", "GPL-3.0-or-later",
  "AGPL-3.0-only", "AGPL-3.0-or-later",
])

function scanLicenses(): Finding[] {
  const findings: Finding[] = []
  const pkgJsons: string[] = []
  walkRepo(CONFIG.ROOT_DIR, (rel, name) => name === "package.json" && !rel.includes("node_modules/"), pkgJsons)

  // Projenin kendi lisansını oku — kopyaleftse zaten bağımlılıklarla uyumlu sayılabilir
  let projectLicense: string | undefined
  if (pkgJsons.length > 0) {
    try {
      const raw = JSON.parse(fs.readFileSync(pkgJsons[0], "utf8")) as { license?: string }
      projectLicense = raw.license
    } catch { /* ignore */ }
  }
  if (!projectLicense || COPYLEFT_LICENSES.has(projectLicense)) {
    return findings  // Proje kendi copyleft ise compat sorunu çıkmaz
  }

  // Direct dependencies'in lisansını node_modules'tan oku
  // (tarama büyükse zaman alabilir; transitive dahil edilmiyor MVP'de)
  for (const pkg of pkgJsons) {
    let manifest: { dependencies?: Record<string, string> }
    try { manifest = JSON.parse(fs.readFileSync(pkg, "utf8")) } catch { continue }
    const deps = manifest.dependencies ?? {}
    const nodeModulesDir = path.join(path.dirname(pkg), "node_modules")
    if (!fs.existsSync(nodeModulesDir)) continue

    for (const depName of Object.keys(deps)) {
      const depPkgJson = path.join(nodeModulesDir, depName, "package.json")
      if (!fs.existsSync(depPkgJson)) continue
      try {
        const depManifest = JSON.parse(fs.readFileSync(depPkgJson, "utf8")) as { license?: string | { type?: string } }
        const lic = typeof depManifest.license === "string"
          ? depManifest.license
          : depManifest.license?.type
        if (lic && COPYLEFT_LICENSES.has(lic)) {
          findings.push(makeFinding(
            "Medium", "license-copyleft-conflict",
            pkg, 1,
            `Bağımlılık '${depName}' copyleft lisansla (${lic}) — proje lisansı '${projectLicense}'.`,
            "Copyleft (GPL/AGPL) lisansları, projeyi de aynı lisansla yayınlamayı zorunlu kılabilir. " +
            "Ticari/proprietary proje için ciddi hukuki risk.",
            `'${depName}' yerine permissive lisanslı (MIT/Apache/BSD) alternatif ara veya ` +
            "hukuk müşaviri ile birlikte lisans uyumunu değerlendir."
          ))
        }
      } catch { /* ignore individual parse failures */ }
    }
  }
  return findings
}

// ─── Orchestrator ──────────────────────────────────────────────────────────
export async function runSecurityAudit(
  options: SecurityAuditOptions = {}
): Promise<SecurityAuditResult> {
  const minSeverity = options.minSeverity ?? "Low"

  const secretsResult = scanSecrets()
  const depsResult = scanDependencies(options.skipDependencyScan ?? false)
  const httpFindings = scanHttpSecurity()
  const authFindings = scanAuthConfig()
  const licenseFindings = scanLicenses()

  const all: Finding[] = [
    ...secretsResult.findings,
    ...depsResult.findings,
    ...httpFindings,
    ...authFindings,
    ...licenseFindings,
  ].filter((f) => meetsMinSeverity(f.severity, minSeverity))

  const enriched = await enrichFindings({ findings: all, roleKey: "security-auditor" })
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
      configFiles: secretsResult.files,
      manifestFiles: depsResult.manifestFiles,
      secretsCandidates: secretsResult.findings.length,
    },
    summary,
    byRule,
    findings: enriched.findings,
  }
}
