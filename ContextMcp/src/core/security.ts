import path from "path"
import fs from "fs"
import { CONFIG } from "./config"

export function resolveSafePath(input: string) {
  const root = path.resolve(CONFIG.ROOT_DIR)
  const target = path.resolve(root, input)

  if (CONFIG.SECURITY?.ENFORCE_ROOT_ISOLATION) {
    if (!target.startsWith(root + path.sep) && target !== root) {
      throw new Error("Access denied: outside root")
    }
  }

  if (!fs.existsSync(target)) {
    throw new Error(`Path does not exist: ${target}`)
  }

  const real = fs.realpathSync(target)

  if (CONFIG.SECURITY?.BLOCK_SYMLINK_ESCAPE) {
    if (!real.startsWith(root + path.sep) && real !== root) {
      throw new Error("Symlink escape detected")
    }
  }

  return real
}

export function isAllowedExtension(file: string) {
  return CONFIG.ALLOWED_EXT.includes(path.extname(file))
}

export function isExcludedDir(dir: string) {
  return CONFIG.EXCLUDED_DIRS.includes(dir)
}