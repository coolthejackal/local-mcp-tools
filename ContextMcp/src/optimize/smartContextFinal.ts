import { buildSmartContext } from "../context/smartContext"
import { compressContext } from "./contextCompressor"

export function buildFinalContext(query: string) {
  const ranked = buildSmartContext(query)
  const compressed = compressContext(ranked)
  return compressed
}