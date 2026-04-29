export type PatternIssue = {
  type: string
  message: string
}

export function detectPatterns(code: string): PatternIssue[] {
  const issues: PatternIssue[] = []

  if (code.includes("==") && !code.includes("===")) {
    issues.push({
      type: "loose-equality",
      message: "Use strict equality (===) instead of =="
    })
  }

  if (code.includes("!value")) {
    issues.push({
      type: "falsy-check",
      message: "Falsy check may hide valid values (0, '', false)"
    })
  }

  if (code.includes("parseInt") && !code.includes("radix")) {
    issues.push({
      type: "missing-radix",
      message: "parseInt without radix can cause unexpected results"
    })
  }

  if (code.includes("any")) {
    issues.push({
      type: "weak-typing",
      message: "Usage of 'any' reduces type safety"
    })
  }

  if (code.includes("TODO")) {
    issues.push({
      type: "todo",
      message: "Unfinished code (TODO found)"
    })
  }

  return issues
}