import ts from "typescript"
import fs from "fs"
import path from "path"
import { getProgram, getTypeChecker } from "../ts/tsIncremental"
import { CONFIG } from "./config"

export type ManifestFunction = {
  name: string
  params: string[]    // "paramName: Type" formatında
  returns: string
  calls: string[]     // çağrılan fonksiyon isimleri
}

export type ManifestFile = {
  functions: ManifestFunction[]
  exports: string[]
  dependencies: string[]  // proje içi import yolları
}

export type ManifestIndex = {
  generated: string
  root: string
  files: Record<string, ManifestFile>
}

export function buildManifest(): ManifestIndex {
  const program = getProgram()
  const checker = getTypeChecker()
  const root = CONFIG.ROOT_DIR

  const manifest: ManifestIndex = {
    generated: new Date().toISOString(),
    root,
    files: {},
  }

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue
    if (!sf.fileName.startsWith(root)) continue

    const relPath = path.relative(root, sf.fileName).replace(/\\/g, "/")
    const fileFunctions: ManifestFunction[] = []
    const exports: string[] = []
    const dependencies: string[] = []

    // Import yollarını topla (sadece yerel)
    sf.statements.forEach((stmt) => {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const mod = stmt.moduleSpecifier.text
        if (mod.startsWith(".")) dependencies.push(mod)
      }
    })

    // Export bildirimlerini topla
    sf.statements.forEach((stmt) => {
      if (ts.isExportDeclaration(stmt) && stmt.exportClause) {
        stmt.exportClause.forEachChild((elem) => {
          if (ts.isExportSpecifier(elem)) exports.push(elem.name.getText())
        })
      }
    })

    // Fonksiyonları çıkar
    function visitNode(node: ts.Node) {
      const info = extractFunctionInfo(node, checker)
      if (info) {
        fileFunctions.push(info)
        if (isExported(node)) exports.push(info.name)
      }
      ts.forEachChild(node, visitNode)
    }
    visitNode(sf)

    if (fileFunctions.length > 0 || exports.length > 0) {
      manifest.files[relPath] = {
        functions: fileFunctions,
        exports: [...new Set(exports)],
        dependencies,
      }
    }
  }

  return manifest
}

export function writeManifest(manifest: ManifestIndex): void {
  const outPath = path.join(CONFIG.ROOT_DIR, "mcp-index.json")
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2), "utf-8")
}

// ─── Yardımcı fonksiyonlar ────────────────────────────────────────────────────

function isExported(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function extractFunctionInfo(
  node: ts.Node,
  checker: ts.TypeChecker
): ManifestFunction | null {
  let name: string | null = null
  let funcNode: ts.FunctionLikeDeclaration | null = null

  if (ts.isFunctionDeclaration(node) && node.name) {
    name = node.name.getText()
    funcNode = node
  } else if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.initializer &&
        (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
      ) {
        name = decl.name.getText()
        funcNode = decl.initializer as ts.ArrowFunction
        break
      }
    }
  } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
    name = node.name.getText()
    funcNode = node
  }

  if (!name || !funcNode) return null

  // Parametre ismi + tip
  const params: string[] = funcNode.parameters.map((param) => {
    const paramName = param.name.getText()
    try {
      const type = checker.getTypeAtLocation(param)
      return `${paramName}: ${checker.typeToString(type)}`
    } catch {
      return paramName
    }
  })

  // Return tipi
  let returns = "unknown"
  try {
    const sig = checker.getSignatureFromDeclaration(funcNode)
    if (sig) returns = checker.typeToString(sig.getReturnType())
  } catch {
    // ignore
  }

  // Çağrılan fonksiyon isimleri
  const calls: string[] = []
  function findCalls(n: ts.Node) {
    if (ts.isCallExpression(n)) {
      const expr = n.expression
      if (ts.isIdentifier(expr)) calls.push(expr.getText())
      else if (ts.isPropertyAccessExpression(expr)) calls.push(expr.name.getText())
    }
    ts.forEachChild(n, findCalls)
  }
  findCalls(funcNode)

  return { name, params, returns, calls: [...new Set(calls)] }
}
