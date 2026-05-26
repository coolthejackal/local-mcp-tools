export type Severity = "Critical" | "High" | "Medium" | "Low" | "Suggestion"

export type Category = "Security" | "Architecture" | "Performance" | "ErrorHandling"

const SEVERITY_RANK: Record<Severity, number> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
  Suggestion: 0,
}

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s]
}

export function meetsMinSeverity(s: Severity, min: Severity): boolean {
  return SEVERITY_RANK[s] >= SEVERITY_RANK[min]
}

export function compareSeverityDesc(a: Severity, b: Severity): number {
  return SEVERITY_RANK[b] - SEVERITY_RANK[a]
}
