import dotenv from "dotenv"
import path from "path"
import fs from "fs"

// ─── .env Yükleme ────────────────────────────────────────────────────────────
// Arama sırası:
//   1. MCPTools/.env  — geliştirme / çoklu MCP paylaşımlı konum
//   2. %APPDATA%\MCPTools\.env  — Windows güvenli konum (production)
function loadEnv(): void {
  const candidates: string[] = [
    path.resolve(__dirname, "../../../.env"),
    path.join(process.env.APPDATA ?? "", "MCPTools", ".env"),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      // quiet: true — dotenv v17 banner'ı stdout'a yazıyor, MCP JSON-RPC'yi bozar
      dotenv.config({ path: candidate, quiet: true })
      return
    }
  }

  const locations = candidates.map(c => `  • ${c}`).join("\n")
  throw new Error(
    `[ContextMCP] .env dosyası bulunamadı.\n` +
    `Aşağıdaki konumlardan birinde bulunmalı:\n${locations}\n\n` +
    `Gerekli içerik:\n  CTX_ROOT=<proje_kök_dizini>\n`
  )
}

loadEnv()

// ─── Kök Dizin Doğrulama ─────────────────────────────────────────────────────
function resolveAndValidateRoot(): string {
  if (!process.env.CTX_ROOT) {
    throw new Error(
      `[ContextMCP] CTX_ROOT tanımlanmamış.\n` +
      `.env dosyasına "CTX_ROOT=<proje_kök_dizini>" eklenmeli.`
    )
  }

  const root = path.resolve(process.env.CTX_ROOT)

  if (!fs.existsSync(root)) {
    throw new Error(
      `[ContextMCP] CTX_ROOT dizini bulunamadı: "${root}"\n` +
      `.env dosyasındaki yolu kontrol edin.`
    )
  }

  if (!fs.statSync(root).isDirectory()) {
    throw new Error(
      `[ContextMCP] CTX_ROOT bir dosyaya değil, dizine işaret etmeli: "${root}"`
    )
  }

  // Sürücü kökü veya sistem dizini kontrolü (C:\, D:\, C:\Windows vb.)
  const parsed = path.parse(root)
  const isTooWide =
    root === parsed.root ||                                    // C:\ gibi sürücü kökü
    root.toLowerCase() === "c:\\windows" ||
    root.toLowerCase() === "c:\\program files" ||
    root.toLowerCase() === "c:\\program files (x86)"

  if (isTooWide) {
    throw new Error(
      `[ContextMCP] CTX_ROOT çok geniş bir dizine işaret ediyor: "${root}"\n` +
      `Sistem veya sürücü kökü taraması engellendi. Proje alt dizinini belirtin.`
    )
  }

  return root
}

const ROOT = resolveAndValidateRoot()

// ─── Güvenlik Uyarıları ───────────────────────────────────────────────────────
function warnIfInsecure(security: { ENFORCE_ROOT_ISOLATION: boolean; BLOCK_SYMLINK_ESCAPE: boolean }): void {
  const warnings: string[] = []

  if (!security.ENFORCE_ROOT_ISOLATION) {
    warnings.push("  ⚠ ENFORCE_ROOT_ISOLATION kapalı — proje dışı dosyalara erişilebilir.")
  }
  if (!security.BLOCK_SYMLINK_ESCAPE) {
    warnings.push("  ⚠ BLOCK_SYMLINK_ESCAPE kapalı — sembolik link ile izolasyon atlatılabilir.")
  }

  if (warnings.length > 0) {
    console.warn(`[ContextMCP] Güvenlik uyarıları:\n${warnings.join("\n")}\n`)
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────
const SECURITY_CONFIG = {
  ENFORCE_ROOT_ISOLATION: true,
  BLOCK_SYMLINK_ESCAPE: true,
}

warnIfInsecure(SECURITY_CONFIG)

export const CONFIG = {
  ROOT_DIR: ROOT,

  ALLOWED_EXT: [".ts", ".tsx", ".js", ".jsx", ".cs"],

  EXCLUDED_DIRS: [
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".turbo",
    "MCPTools",
    "bin",
    "obj",
    "docs"
  ],

  MAX_FILE_SIZE: 50_000,
  MAX_FILES: 5_000,

  TOKEN_LIMIT: 8000,
  FILE_TOKEN_LIMIT: 800,

  CONTEXT_TOP_K: 12,
  GRAPH_TRAVERSAL_DEPTH: 2,
  BUG_TRAVERSAL_DEPTH: 3,

  WATCH_IGNORE: [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**"
  ],

  SECURITY: SECURITY_CONFIG,
}

export function resolveRoot(...segments: string[]) {
  return path.join(CONFIG.ROOT_DIR, ...segments)
}
