import { detectBugSignals, BugSignal } from "./bugSignals"
import { detectPatterns, PatternIssue } from "./patternAnalyzer"

export type LineAnalysis = BugSignal & {
  patterns: PatternIssue[]
}

export function analyzeFileForBugs(code: string, topK: number = 10): LineAnalysis[] {
  const signals = detectBugSignals(code)
  const patterns = detectPatterns(code)

  return signals
    .map(s => ({
      ...s,
      patterns
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}