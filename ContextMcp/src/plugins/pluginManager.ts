import { MCPPlugin } from "./pluginSystem"

const plugins: MCPPlugin[] = []

export function registerPlugin(plugin: MCPPlugin) {
  plugins.push(plugin)
}

export function runOnIndex(file: string, content: string) {
  for (const p of plugins) {
    p.onIndex?.(file, content)
  }
}

export function runOnContextBuild(ctx: Record<string, any>) {
  for (const p of plugins) {
    p.onContextBuild?.(ctx)
  }
}

export function runOnQuery(query: string, ctx: Record<string, any>) {
  const results: any[] = []

  for (const p of plugins) {
    const r = p.onQuery?.(query, ctx)
    if (r) results.push({ plugin: p.name, result: r })
  }

  return results
}

export function registerAllTools(server: any) {
  for (const p of plugins) {
    p.registerTools?.(server)
  }
}