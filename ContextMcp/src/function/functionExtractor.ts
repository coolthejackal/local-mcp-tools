import ts from "typescript"
import { getProgram } from "../ts/tsIncremental"

export type ExtractedFunction = {
  name: string
  file: string
  content: string
  start: number
  end: number
}

export function extractFunctionsFromFile(fileName: string): ExtractedFunction[] {
  const program = getProgram()
  const source = program.getSourceFile(fileName)

  if (!source) return []

  const functions: ExtractedFunction[] = []

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const start = node.getStart()
      const end = node.getEnd()

      functions.push({
        name: node.name.getText(),
        file: fileName,
        content: source!.text.slice(start, end),
        start,
        end
      })
    }

    if (ts.isVariableStatement(node)) {
      node.declarationList.declarations.forEach(decl => {
        if (
          ts.isVariableDeclaration(decl) &&
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          ts.isArrowFunction(decl.initializer)
        ) {
          const start = decl.getStart()
          const end = decl.getEnd()

          functions.push({
            name: decl.name.getText(),
            file: fileName,
            content: source!.text.slice(start, end),
            start,
            end
          })
        }
      })
    }

    if (ts.isClassDeclaration(node)) {
      node.members.forEach(member => {
        if (
          ts.isMethodDeclaration(member) &&
          member.name &&
          ts.isIdentifier(member.name)
        ) {
          const start = member.getStart()
          const end = member.getEnd()

          functions.push({
            name: member.name.getText(),
            file: fileName,
            content: source!.text.slice(start, end),
            start,
            end
          })
        }
      })
    }

    ts.forEachChild(node, visit)
  }

  visit(source)

  return functions
}