export function traverseGraph(
  graph: Record<string, { target: string }[]>,
  seeds: string[],
  depth: number = 2
) {
  const visited = new Set<string>()
  let current = [...seeds]
  let level = 0

  while (current.length && level < depth) {
    const next: string[] = []

    for (const node of current) {
      if (visited.has(node)) continue

      visited.add(node)

      const edges = graph[node] || []

      for (const e of edges) {
        if (!visited.has(e.target)) {
          next.push(e.target)
        }
      }
    }

    current = next
    level++
  }

  return Array.from(visited)
}