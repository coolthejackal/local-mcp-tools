import ts from "typescript"
import { getProgram } from "../ts/tsIncremental"

export type DataFlowItem =
  | {
      type: "param-usage"
      param: string
      location: number
    }
  | {
      type: "return"
      value: string | undefined
    }

export function analyzeDataFlow(file: string, functionName: string): DataFlowItem[] {
  const program = getProgram()
  const source = program.getSourceFile(file)

  if (!source) return []

  const flows: DataFlowItem[] = []

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.getText() === functionName) {
      const params = node.parameters.map(p => p.name.getText())

      function scan(child: ts.Node) {
        if (ts.isIdentifier(child) && params.includes(child.getText())) {
          flows.push({
            type: "param-usage",
            param: child.getText(),
            location: child.getStart()
          })
        }

        if (ts.isReturnStatement(child)) {
          flows.push({
            type: "return",
            value: child.expression?.getText()
          })
        }

        ts.forEachChild(child, scan)
      }

      ts.forEachChild(node, scan)
    }

    ts.forEachChild(node, visit)
  }

  visit(source)

  return flows
}