export interface MCPPlugin {
  name: string

  onIndex?(file: string, content: string): void

  onContextBuild?(ctx: Record<string, any>): void

  onQuery?(query: string, ctx: Record<string, any>): any

  registerTools?(server: any): void
}