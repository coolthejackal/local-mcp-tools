import { buildSmartContext } from "../../context/smartContext"

const TS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]
const CS_EXT = [".cs"]

export type RelevantFiles = {
  query: string
  all: string[]
  ts: string[]
  cs: string[]
}

export function findRelevantFiles(query: string): RelevantFiles {
  const ranked = buildSmartContext(query)
  const all = ranked
    .map((r) => r.file)
    .filter((f) => f !== "__warning__")

  return {
    query,
    all,
    ts: all.filter((f) => TS_EXT.some((ext) => f.toLowerCase().endsWith(ext))),
    cs: all.filter((f) => CS_EXT.some((ext) => f.toLowerCase().endsWith(ext))),
  }
}

export function isTsFile(file: string): boolean {
  const lower = file.toLowerCase()
  return TS_EXT.some((ext) => lower.endsWith(ext))
}

export function isCsFile(file: string): boolean {
  return file.toLowerCase().endsWith(".cs")
}
