import { getContext } from "../core/indexer"

export function findSeeds(keywords: string[], limit: number = 5) {
  const ctx = getContext()
  const results: string[] = []

  for (const [file, data] of Object.entries(ctx)) {
    const content = data.content.toLowerCase()

    if (keywords.some(k => content.includes(k))) {
      results.push(file)
      if (results.length >= limit) break
    }
  }

  return results
}