import { analyzeIntent } from "./intentAnalyzer"
import { findSeeds } from "./seedFinder"
import { rankContext } from "./contextScorer"
import { traverseGraph } from "../graph/graphTraversal"
import { getGraph } from "../core/indexer"
import { CONFIG } from "../core/config"

export function buildSmartContext(query: string) {
  const intent = analyzeIntent(query)

  const seeds = findSeeds(intent.keywords, CONFIG.CONTEXT_TOP_K)

  const graph = getGraph()

  const expanded = traverseGraph(
    graph,
    seeds,
    intent.wantsBug
      ? CONFIG.BUG_TRAVERSAL_DEPTH
      : CONFIG.GRAPH_TRAVERSAL_DEPTH
  )

  const ranked = rankContext(expanded, query, CONFIG.CONTEXT_TOP_K)

  return ranked
}