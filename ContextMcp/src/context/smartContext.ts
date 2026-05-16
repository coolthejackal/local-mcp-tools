import { analyzeIntent } from "./intentAnalyzer"
import { findSeeds } from "./seedFinder"
import { rankContext } from "./contextScorer"
import { traverseGraph } from "../graph/graphTraversal"
import { getGraph } from "../core/indexer"
import { CONFIG } from "../core/config"
import { searchManifest, isManifestStale } from "../core/manifestReader"

export function buildSmartContext(query: string) {
  const intent = analyzeIntent(query)

  // ── 1. Manifest'e önce bak — eşleşen dosyaların mutlak yolları ────────────
  const manifestHits = searchManifest(query)
  const manifestFiles = new Set(manifestHits.map((r) => r.absPath))

  // ── 2. TF-IDF + graph pipeline ───────────────────────────────────────────
  const seeds = findSeeds(intent.keywords, CONFIG.CONTEXT_TOP_K)

  // Manifest'ten gelen dosyaları seed'lere öne ekle
  for (const mf of manifestFiles) {
    if (!seeds.includes(mf)) seeds.unshift(mf)
  }

  const graph = getGraph()

  const expanded = traverseGraph(
    graph,
    seeds,
    intent.wantsBug ? CONFIG.BUG_TRAVERSAL_DEPTH : CONFIG.GRAPH_TRAVERSAL_DEPTH
  )

  const ranked = rankContext(expanded, query, CONFIG.CONTEXT_TOP_K)

  // ── 3. Manifest eski/yok ise uyar ────────────────────────────────────────
  const staleWarning = isManifestStale()
    ? [{ file: "__warning__", score: 0, note: "manifest eski/yok — build_context çalıştırın" }]
    : []

  return [...staleWarning, ...ranked]
}
