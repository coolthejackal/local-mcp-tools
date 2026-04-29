export type Intent = {
  keywords: string[]
  wantsBug: boolean
  wantsFunction: boolean
  wantsApi: boolean
}

export function analyzeIntent(query: string): Intent {
  const q = (query || "").toLowerCase()

  const keywords = q
    .split(/[\s,]+/)
    .map(w => w.trim())
    .filter(Boolean)

  return {
    keywords,
    wantsBug: q.includes("bug") || q.includes("error") || q.includes("issue"),
    wantsFunction: q.includes("function") || q.includes("method"),
    wantsApi: q.includes("api") || q.includes("endpoint") || q.includes("fetch")
  }
}