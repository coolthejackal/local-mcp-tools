import ts from "typescript"
import { CONFIG } from "../core/config"

let program: ts.Program | null = null

export function initTS() {
  const configPath = ts.findConfigFile(
    CONFIG.ROOT_DIR,
    ts.sys.fileExists,
    "tsconfig.json"
  )

  if (!configPath) {
    throw new Error("tsconfig.json not found")
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)

  if (configFile.error) {
    throw new Error("Error reading tsconfig.json")
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    CONFIG.ROOT_DIR
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