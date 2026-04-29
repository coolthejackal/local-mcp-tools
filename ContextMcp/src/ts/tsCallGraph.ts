import ts from "typescript"
import { getProgram, getTypeChecker } from "./tsIncremental"

export type FileCallGraph = Record<string, { target: string }[]>

export function buildTSCallGraph(): FileCallGraph {
  const program = getProgram()
  const checker = getTypeChecker()

  const graph: FileCallGraph = {}

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue

    const fileName = sf.fileName
    graph[fileName] = []

    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const sig = checker.getResolvedSignature(node)
        const decl = sig?.getDeclaration()

        if (decl) {
          const targetFile = decl.getSourceFile().fileName
          graph[fileName].push({ target: targetFile })
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sf)
  }

  return graph
}