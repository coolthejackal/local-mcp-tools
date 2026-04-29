import { analyzeDataFlow } from "./dataFlow"
import { buildFunctionGraph } from "../graph/functionGraph"
import { CONFIG } from "../core/config"

export type DataFlowChainItem = {
  function: string
  flow: ReturnType<typeof analyzeDataFlow>
}

export function buildDataFlowChain(start: string, depth: number = CONFIG.GRAPH_TRAVERSAL_DEPTH) {
  const graph = buildFunctionGraph()

  const visited = new Set<string>()
  let current = [start]

  const result: DataFlowChainItem[] = []
  let level = 0

  while (current.length && level < depth) {
    const next: string[] = []

    for (const fn of current) {
      if (visited.has(fn)) continue

      visited.add(fn)

      const [file, name] = fn.split(":")

      const flow = analyzeDataFlow(file, name)

      result.push({
        function: fn,
        flow
      })

      const edges = graph[fn] || []

      for (const e of edges) {
        if (!visited.has(e)) {
          next.push(e)
        }
      }
    }

    current = next
    level++
  }

  return result
}