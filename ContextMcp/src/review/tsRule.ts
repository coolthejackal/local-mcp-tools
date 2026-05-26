import ts from "typescript"
import type { Finding } from "./finding"
import type { Category } from "./severity"

export type TsRule = {
  name: string
  category: Category
  check: (sf: ts.SourceFile, fileName: string) => Finding[]
}

export function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1
}

export function isInsideLoop(node: ts.Node): boolean {
  let p: ts.Node | undefined = node.parent
  while (p) {
    if (
      ts.isForStatement(p) ||
      ts.isForInStatement(p) ||
      ts.isForOfStatement(p) ||
      ts.isWhileStatement(p) ||
      ts.isDoStatement(p)
    ) {
      return true
    }
    if (ts.isFunctionLike(p)) return false
    p = p.parent
  }
  return false
}

export function isInsideTry(node: ts.Node): boolean {
  let p: ts.Node | undefined = node.parent
  while (p) {
    if (ts.isTryStatement(p)) return true
    if (ts.isFunctionLike(p)) return false
    p = p.parent
  }
  return false
}

export function enclosingAsyncFunction(node: ts.Node): ts.Node | null {
  let p: ts.Node | undefined = node.parent
  while (p) {
    if (
      (ts.isFunctionDeclaration(p) ||
        ts.isFunctionExpression(p) ||
        ts.isArrowFunction(p) ||
        ts.isMethodDeclaration(p)) &&
      p.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      return p
    }
    p = p.parent
  }
  return null
}

export function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

export function countLines(sf: ts.SourceFile, start: number, end: number): number {
  const s = sf.getLineAndCharacterOfPosition(start).line
  const e = sf.getLineAndCharacterOfPosition(end).line
  return e - s + 1
}
