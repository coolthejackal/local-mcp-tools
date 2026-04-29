import { estimateTokens } from "./tokenEstimator"
import { summarizeCode } from "./codeSummarizer"
import { getContext } from "../core/indexer"
import { CONFIG } from "../core/config"

type RankedFile = { file: string; score: number }

export function compressContext(ranked: RankedFile[]) {
  const ctx = getContext()

  let total = 0
  const result: { file: string; content: string; tokens: number }[] = []

  for (const item of ranked) {
    const raw = ctx[item.file]?.content || ""

    let content = raw
    let tokens = estimateTokens(content)

    if (tokens > CONFIG.FILE_TOKEN_LIMIT) {
      content = summarizeCode(content)
      tokens = estimateTokens(content)
    }

    if (total + tokens > CONFIG.TOKEN_LIMIT) break

    total += tokens

    result.push({
      file: item.file,
      content,
      tokens
    })
  }

  return result
}