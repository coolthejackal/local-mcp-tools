import { getProgram } from "../ts/tsIncremental"
import type { Finding } from "./finding"
import type { Category } from "./severity"
import type { TsRule } from "./tsRule"
import { SECURITY_RULES } from "./rules/securityRules"
import { ARCHITECTURE_RULES } from "./rules/architectureRules"
import { PERFORMANCE_RULES } from "./rules/performanceRules"
import { ERROR_HANDLING_RULES } from "./rules/errorHandlingRules"

const ALL_RULES: TsRule[] = [
  ...SECURITY_RULES,
  ...ARCHITECTURE_RULES,
  ...PERFORMANCE_RULES,
  ...ERROR_HANDLING_RULES,
]

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]

export function isTsFile(file: string): boolean {
  const lower = file.toLowerCase()
  return TS_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export function runTsRules(files: string[], categories?: Category[]): Finding[] {
  const program = getProgram()
  const out: Finding[] = []
  const activeRules = categories?.length
    ? ALL_RULES.filter((r) => categories.includes(r.category))
    : ALL_RULES

  for (const file of files) {
    if (!isTsFile(file)) continue

    const sf = program.getSourceFile(file)
    if (!sf) continue

    for (const rule of activeRules) {
      try {
        const findings = rule.check(sf, file)
        out.push(...findings)
      } catch (err) {
        process.stderr.write(
          `[review] kural '${rule.name}' '${file}' üzerinde hata verdi: ${(err as Error).message}\n`
        )
      }
    }
  }

  return out
}
