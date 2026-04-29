export type BugSignal = {
  line: number
  code: string
  score: number
}

export function detectBugSignals(code: string): BugSignal[] {
  const lines = code.split("\n")

  return lines.map((line, i) => {
    let score = 0

    const l = line.trim()

    if (l.includes("if")) score += 1
    if (l.includes("!")) score += 1
    if (l.includes("null")) score += 2
    if (l.includes("undefined")) score += 2
    if (l.includes("==")) score += 2
    if (l.includes("parseInt")) score += 1
    if (l.includes("Math")) score += 1
    if (l.includes("any")) score += 1
    if (l.includes("TODO")) score += 1

    return {
      line: i + 1,
      code: l,
      score
    }
  })
}