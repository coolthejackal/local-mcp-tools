import ts from "typescript"
import { getProgram, getTypeChecker } from "../ts/tsIncremental"

export type FunctionGraph = Record<string, string[]>

export function buildFunctionGraph(): FunctionGraph {
  const program = getProgram()
  const checker = getTypeChecker()

  const graph: FunctionGraph = {}

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue

    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const fnName = node.name.getText()
        const key = `${sf.fileName}:${fnName}`

        graph[key] = []

        function scan(child: ts.Node) {
          if (ts.isCallExpression(child)) {
            const sig = checker.getResolvedSignature(child)
            const decl = sig?.getDeclaration()

            if (decl && decl.name) {
              const targetName = decl.name.getText()
              const targetFile = decl.getSourceFile().fileName
              graph[key].push(`${targetFile}:${targetName}`)
            }
          }

          ts.forEachChild(child, scan)
        }

        ts.forEachChild(node, scan)
      }

      ts.forEachChild(node, visit)
    }

    visit(sf)
  }

  return graph
}