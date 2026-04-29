import fs from "fs"
import path from "path"
import { CONFIG } from "./config"
import { isAllowedExtension, isExcludedDir, resolveSafePath } from "./security"
import { indexDocument } from "./semantic"
import { initTS } from "../ts/tsIncremental"
import { buildTSCallGraph } from "../ts/tsCallGraph"
import { runOnIndex, runOnContextBuild } from "../plugins/pluginManager"

type FileCtx = {
  content: string
  size: number
}

let ctx: Record<string, FileCtx> = {}
let graph: Record<string, any[]> = {}

export function buildContext() {
  initTS()

  ctx = {}
  let count = 0

  walk(CONFIG.ROOT_DIR, (file) => {
    if (count >= CONFIG.MAX_FILES) return

    if (!isAllowedExtension(file)) return

    const safe = resolveSafePath(file)

    const stat = fs.statSync(safe)
    if (!stat.isFile()) return
    if (stat.size > CONFIG.MAX_FILE_SIZE) return

    const content = fs.readFileSync(safe, "utf-8")

    ctx[safe] = {
      content: sanitize(content),
      size: stat.size
    }

    indexDocument(content)
    runOnIndex(safe, content)

    count++
  })

  graph = buildTSCallGraph()
  runOnContextBuild(ctx)
}

function walk(dir: string, onFile: (file: string) => void) {
  const entries = fs.readdirSync(dir)

  for (const entry of entries) {
    const full = path.join(dir, entry)
    const stat = fs.statSync(full)

    if (stat.isDirectory()) {
      if (isExcludedDir(entry)) continue
      walk(full, onFile)
    } else {
      onFile(full)
    }
  }
}

function sanitize(c: string): string {
  return c
    // API key / secret / token patterns (key=value veya key: value)
    .replace(/(?:api[_-]?key|apikey|access[_-]?key)\s*[:=]\s*\S+/gi, "apiKey=***")
    .replace(/(?:password|passwd|pwd)\s*[:=]\s*\S+/gi, "password=***")
    .replace(/(?:secret|client[_-]?secret|app[_-]?secret)\s*[:=]\s*\S+/gi, "secret=***")
    .replace(/(?:token|access[_-]?token|auth[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+/gi, "token=***")
    .replace(/(?:private[_-]?key|signing[_-]?key)\s*[:=]\s*\S+/gi, "privateKey=***")
    // Database / connection string
    .replace(/(?:database[_-]?url|connection[_-]?string|db[_-]?url|db[_-]?pass)\s*[:=]\s*\S+/gi, "dbUrl=***")
    .replace(/(?:mongodb|postgresql|mysql|redis|mssql):\/\/[^\s"'`]+/gi, "[DB_URL_REDACTED]")
    // PEM / private key blokları
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, "[KEY_REDACTED]")
    // Bearer token ve JWT
    .replace(/Bearer\s+[A-Za-z0-9._~+/]+=*/gi, "Bearer ***")
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, "[JWT_REDACTED]")
    .slice(0, CONFIG.MAX_FILE_SIZE)
}

export function getContext() {
  return ctx
}

export function getGraph() {
  return graph
}