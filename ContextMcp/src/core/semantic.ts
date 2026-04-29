const docFreq: Record<string, number> = {}
let totalDocs = 0

export function indexDocument(text: string) {
  totalDocs++

  const words = tokenize(text)
  const unique = new Set(words)

  for (const w of unique) {
    docFreq[w] = (docFreq[w] || 0) + 1
  }
}

export function score(query: string, doc: string) {
  const qWords = tokenize(query)
  const dWords = tokenize(doc)

  let s = 0

  for (const w of qWords) {
    const tf = dWords.filter(x => x === w).length
    const idf = Math.log((totalDocs + 1) / ((docFreq[w] || 1)))
    s += tf * idf
  }

  return s
}

function tokenize(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter(Boolean)
}