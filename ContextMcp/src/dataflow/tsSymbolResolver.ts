import ts from "typescript"
import { getProgram, getTypeChecker } from "../ts/tsIncremental"

export type ResolvedTarget = {
  file: string
  name: string
}

export function resolveCallTarget(node: ts.CallExpression): ResolvedTarget | null {
  const checker = getTypeChecker()

  const sig = checker.getResolvedSignature(node)
  const decl = sig?.getDeclaration()

  if (!decl) return null

  const source = decl.getSourceFile()
  const name =
    (decl as any).name?.getText?.() ||
    (ts.isFunctionDeclaration(decl) && decl.name?.getText()) ||
    "anonymous"

  return {
    file: source.fileName,
    name
  }
}