import { score } from "../core/semantic"
import { getContext } from "../core/indexer"

export function rankContext(files: string[], query: string, topK: number = 10) {
  const ctx = getContext()

  return files
    .map(file => ({
      file,
      score: score(query, ctx[file]?.content || "")
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}