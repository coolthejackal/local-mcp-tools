import { buildSmartContext } from "../context/smartContext"
import { analyzeFunctionsForBugs } from "./functionBugAnalyzer"

export type BugResult = {
  file: string
  analysis: ReturnType<typeof analyzeFunctionsForBugs>
}

export function findBug(query: string): BugResult[] {
  const files = buildSmartContext(query)

  const results: BugResult[] = []

  for (const f of files) {
    const filePath = f.file

    results.push({
      file: filePath,
      analysis: analyzeFunctionsForBugs(filePath)
    })
  }

  return results
}