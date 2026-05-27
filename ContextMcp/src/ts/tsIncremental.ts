import ts from "typescript"
import fs from "fs"
import path from "path"
import { CONFIG } from "../core/config"

let program: ts.Program | null = null

export function initTS(root: string = CONFIG.ROOT_DIR) {
  // İlk önce kök dizinde tsconfig.json'u ara (ts.findConfigFile yukarı doğru tarar).
  const direct = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json")

  const configPaths: string[] = []
  if (direct) {
    configPaths.push(direct)
  } else {
    // Monorepo: alt klasörlerde tsconfig.json ara (frontend/, packages/foo/ vb.)
    configPaths.push(...findTsConfigsRecursive(root))
  }

  if (configPaths.length === 0) {
    throw new Error(
      `tsconfig.json bulunamadı: ${root} ve alt klasörlerinde. ` +
      `JavaScript-only proje veya tsconfig'siz monorepo desteklenmiyor.`
    )
  }

  const allFileNames = new Set<string>()
  let baseOptions: ts.CompilerOptions = {}

  for (const cfgPath of configPaths) {
    const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile)
    if (cfg.error) {
      process.stderr.write(`[ts] tsconfig okunamadı: ${cfgPath}\n`)
      continue
    }
    const parsed = ts.parseJsonConfigFileContent(
      cfg.config,
      ts.sys,
      path.dirname(cfgPath)
    )
    for (const f of parsed.fileNames) allFileNames.add(f)
    if (Object.keys(baseOptions).length === 0) baseOptions = parsed.options
  }

  if (allFileNames.size === 0) {
    throw new Error(`tsconfig(ler) bulundu (${configPaths.length}) ama hiç dosya çözülmedi.`)
  }

  program = ts.createProgram(Array.from(allFileNames), baseOptions)
}

function findTsConfigsRecursive(dir: string, accumulator: string[] = []): string[] {
  let items: fs.Dirent[]
  try {
    items = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return accumulator
  }
  for (const it of items) {
    if (it.isDirectory()) {
      if (CONFIG.EXCLUDED_DIRS.includes(it.name)) continue
      findTsConfigsRecursive(path.join(dir, it.name), accumulator)
    } else if (it.name === "tsconfig.json") {
      accumulator.push(path.join(dir, it.name))
    }
  }
  return accumulator
}

export function getProgram() {
  if (!program) {
    throw new Error("TS Program not initialized")
  }

  return program
}

export function getTypeChecker() {
  return getProgram().getTypeChecker()
}
