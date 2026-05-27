import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"
import { CONFIG } from "../../../core/config"

// Project Manager raporu — git log, branch state, TODO envanteri.
// Bulgu (Finding) üretmek yerine yapılandırılmış rapor döner.

export type PmStatusOptions = {
  sinceDays?: number
  deadBranchDays?: number
}

export type PmStatusResult = {
  branch: string
  commitActivity: {
    sinceDays: number
    totalCommits: number
    byAuthor: Array<{ author: string; commits: number }>
  }
  deadBranches: Array<{ name: string; lastCommitDate: string; daysStale: number }>
  workInProgressCommits: Array<{ sha: string; author: string; date: string; subject: string }>
  todoInventory: {
    total: number
    byOwner: Record<string, number>
    items: Array<{ file: string; line: number; type: "TODO" | "FIXME" | "HACK" | "XXX"; owner?: string; text: string }>
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
  const out = gitExec(["rev-parse", "--is-inside-work-tree"])
  return out.trim() === "true"
}

function currentBranch(): string {
  return gitExec(["rev-parse", "--abbrev-ref", "HEAD"]).trim()
}

function commitActivity(sinceDays: number): PmStatusResult["commitActivity"] {
  const since = `${sinceDays}.days.ago`
  const output = gitExec([
    "log", "--no-merges",
    "--since", since,
    "--pretty=format:%an",
    "--all",
  ])
  if (!output) {
    return { sinceDays, totalCommits: 0, byAuthor: [] }
  }
  const lines = output.split(/\r?\n/).filter(Boolean)
  const counts = new Map<string, number>()
  for (const a of lines) counts.set(a, (counts.get(a) ?? 0) + 1)
  return {
    sinceDays,
    totalCommits: lines.length,
    byAuthor: Array.from(counts.entries())
      .map(([author, commits]) => ({ author, commits }))
      .sort((a, b) => b.commits - a.commits),
  }
}

function deadBranches(deadDays: number): PmStatusResult["deadBranches"] {
  // remote branches ile son commit tarihi
  const out = gitExec([
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)|%(committerdate:iso8601)",
    "refs/remotes",
  ])
  if (!out) return []
  const now = Date.now()
  const result: PmStatusResult["deadBranches"] = []
  for (const rawLine of out.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const [name, date] = line.split("|")
    if (!name || !date) continue
    if (name.endsWith("/HEAD")) continue
    const ts = Date.parse(date)
    if (isNaN(ts)) continue
    const days = Math.floor((now - ts) / (1000 * 60 * 60 * 24))
    if (days >= deadDays) {
      result.push({ name, lastCommitDate: date, daysStale: days })
    }
  }
  return result
}

function wipCommits(): PmStatusResult["workInProgressCommits"] {
  const out = gitExec([
    "log", "--all", "--no-merges",
    "--pretty=format:%h|%an|%ai|%s",
    "-i", "--grep=^wip\\|^fixup!\\|^squash!",
  ])
  if (!out) return []
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [sha, author, date, ...rest] = line.split("|")
    return { sha, author, date, subject: rest.join("|") }
  })
}

const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b(?:\(([^)]+)\))?:?\s*(.{0,200})/i

function todoInventory(): PmStatusResult["todoInventory"] {
  const items: PmStatusResult["todoInventory"]["items"] = []
  const byOwner: Record<string, number> = {}

  function visit(dir: string): void {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      const rel = path.relative(CONFIG.ROOT_DIR, full).replace(/\\/g, "/")
      if (e.isDirectory()) {
        if (rel.split("/").some((seg) => CONFIG.EXCLUDED_DIRS.includes(seg))) continue
        visit(full)
        continue
      }
      const ext = path.extname(e.name).toLowerCase()
      if (![".ts", ".tsx", ".js", ".jsx", ".cs"].includes(ext)) continue
      let text: string
      try {
        const stat = fs.statSync(full)
        if (stat.size > 500_000) continue
        text = fs.readFileSync(full, "utf8")
      } catch { continue }
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(TODO_RE)
        if (!m) continue
        const type = m[1].toUpperCase() as "TODO" | "FIXME" | "HACK" | "XXX"
        const owner = m[2]?.trim()
        const tail = m[3]?.trim() ?? ""
        items.push({
          file: full,
          line: i + 1,
          type,
          owner,
          text: tail.substring(0, 150),
        })
        if (owner) byOwner[owner] = (byOwner[owner] ?? 0) + 1
      }
    }
  }
  visit(CONFIG.ROOT_DIR)

  return { total: items.length, byOwner, items }
}

export function runPmStatus(options: PmStatusOptions = {}): PmStatusResult {
  const sinceDays = options.sinceDays ?? 30
  const deadDays = options.deadBranchDays ?? 30

  if (!isGitRepo()) {
    return {
      branch: "(not-a-git-repo)",
      commitActivity: { sinceDays, totalCommits: 0, byAuthor: [] },
      deadBranches: [],
      workInProgressCommits: [],
      todoInventory: todoInventory(),
    }
  }

  return {
    branch: currentBranch(),
    commitActivity: commitActivity(sinceDays),
    deadBranches: deadBranches(deadDays),
    workInProgressCommits: wipCommits(),
    todoInventory: todoInventory(),
  }
}
