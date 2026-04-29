import ts from "typescript"
import { getProgram, getTypeChecker } from "./tsIncremental"

export type SymbolIndex = Record<string, string>

export function buildSymbolIndex(): SymbolIndex {
  const program = getProgram()
  const checker = getTypeChecker()

  const map: SymbolIndex = {}

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue

    ts.forEachChild(sf, node => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const sym = checker.getSymbolAtLocation(node.name)
        if (sym) {
          map[sym.getName()] = sf.fileName
        }
      }

      if (ts.isClassDeclaration(node) && node.name) {
        const sym = checker.getSymbolAtLocation(node.name)
        if (sym) {
          map[sym.getName()] = sf.fileName
        }
      }
    })
  }

  return map
}