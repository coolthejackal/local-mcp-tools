import { extractFunctionsFromFile, ExtractedFunction } from "./functionExtractor"
import { getContext } from "../core/indexer"

export type FunctionContext = {
  file: string
  functions: {
    name: string
    content: string
  }[]
}

export function buildFunctionContext(query: string): FunctionContext[] {
  const ctx = getContext()
  const q = (query || "").toLowerCase()

  const results: FunctionContext[] = []

  for (const file of Object.keys(ctx)) {
    const functions: ExtractedFunction[] = extractFunctionsFromFile(file)

    const matched = functions.filter(fn =>
      fn.name.toLowerCase().includes(q) ||
      fn.content.toLowerCase().includes(q)
    )

    if (matched.length > 0) {
      results.push({
        file,
        functions: matched.map(m => ({
          name: m.name,
          content: m.content
        }))
      })
    }
  }

  return results
}
