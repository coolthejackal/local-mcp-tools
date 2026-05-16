import ts from "typescript"
import { CONFIG } from "../core/config"

let program: ts.Program | null = null

export function initTS(root: string = CONFIG.ROOT_DIR) {
  const configPath = ts.findConfigFile(
    root,
    ts.sys.fileExists,
    "tsconfig.json"
  )

  if (!configPath) {
    throw new Error(`tsconfig.json not found: ${root}`)
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)

  if (configFile.error) {
    throw new Error("Error reading tsconfig.json")
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    root
  )

  program = ts.createProgram(parsed.fileNames, parsed.options)
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