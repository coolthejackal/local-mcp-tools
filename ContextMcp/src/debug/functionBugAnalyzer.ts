import { extractFunctionsFromFile } from "../function/functionExtractor"
import { analyzeFileForBugs } from "./lineAnalyzer"

export type FunctionBugAnalysis = {
  function: string
  file: string
  issues: ReturnType<typeof analyzeFileForBugs>
}

export function analyzeFunctionsForBugs(file: string): FunctionBugAnalysis[] {
  const functions = extractFunctionsFromFile(file)

  return functions.map(fn => ({
    function: fn.name,
    file,
    issues: analyzeFileForBugs(fn.content)
  }))
}