import ts from "typescript"
import { getProgram } from "../../../ts/tsIncremental"
import { CONFIG } from "../../../core/config"
import type { Finding } from "../../shared/finding"
import type { Severity } from "../../shared/severity"
import { compareSeverityDesc, meetsMinSeverity } from "../../shared/severity"
import { walk, lineOf } from "../../../review/tsRule"
import { enrichFindings } from "../../shared/llm/enrich"

const CATEGORY = "QA"
const TEST_FILE_RE = /(\.spec|\.test)\.(ts|tsx|js|jsx)$/i

type TestCase = {
  file: string
  line: number
  name: string
  skipped: boolean
  hasAssertion: boolean
  hasTodo: boolean
  mockCount: number
}

type ProductionFn = {
  file: string
  line: number
  name: string
  // Test'te aranacak basit anahtar — function adının lowercase'i
  searchKey: string
}

export type QaAuditOptions = {
  minSeverity?: Severity
  excessiveMocksThreshold?: number
}

export type QaAuditResult = {
  productionFnCount: number
  testCount: number
  testsAnalyzed: number
  summary: Record<Lowercase<Severity>, number>
  byRule: Record<string, number>
  findings: Finding[]
}

function collectFiles(): { source: string[]; test: string[] } {
  const program = getProgram()
  const source: string[] = []
  const test: string[] = []
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue
    const file = sf.fileName
    if (!file.startsWith(CONFIG.ROOT_DIR)) continue
    if (TEST_FILE_RE.test(file)) test.push(file)
    else source.push(file)
  }
  return { source, test }
}

function extractProductionFns(files: string[]): ProductionFn[] {
  const program = getProgram()
  const out: ProductionFn[] = []
  for (const file of files) {
    const sf = program.getSourceFile(file)
    if (!sf) continue
    walk(sf, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        out.push({
          file,
          line: lineOf(sf, node.getStart(sf)),
          name: node.name.text,
          searchKey: node.name.text.toLowerCase(),
        })
      }
      if (
        ts.isVariableStatement(node) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        node.declarationList.declarations.forEach((decl) => {
          if (
            ts.isVariableDeclaration(decl) &&
            ts.isIdentifier(decl.name) &&
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
          ) {
            out.push({
              file,
              line: lineOf(sf, decl.getStart(sf)),
              name: decl.name.text,
              searchKey: decl.name.text.toLowerCase(),
            })
          }
        })
      }
    })
  }
  return out
}

function extractTestCases(files: string[]): TestCase[] {
  const program = getProgram()
  const out: TestCase[] = []
  for (const file of files) {
    const sf = program.getSourceFile(file)
    if (!sf) continue
    walk(sf, (node) => {
      if (!ts.isCallExpression(node)) return
      const callee = node.expression
      const calleeText = callee.getText(sf)

      // it / test / it.skip / xit
      let kind: "it" | "test" | null = null
      let skipped = false
      if (calleeText === "it" || calleeText === "test") {
        kind = calleeText
      } else if (calleeText === "xit" || calleeText === "xtest") {
        kind = calleeText === "xit" ? "it" : "test"
        skipped = true
      } else if (calleeText === "it.skip" || calleeText === "test.skip") {
        kind = calleeText.startsWith("it") ? "it" : "test"
        skipped = true
      }
      if (!kind) return

      const nameArg = node.arguments[0]
      if (!nameArg || (!ts.isStringLiteralLike(nameArg) && !ts.isNoSubstitutionTemplateLiteral(nameArg))) return
      const name = "text" in nameArg ? (nameArg as ts.StringLiteralLike).text : "(?)"

      const bodyArg = node.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a))
      let hasAssertion = false
      let hasTodo = false
      let mockCount = 0
      if (bodyArg) {
        const bodyText = bodyArg.getText(sf)
        hasAssertion = /\b(expect|assert|chai|should)\b/.test(bodyText)
        hasTodo = /\bTODO\b|\bFIXME\b/.test(bodyText)
        const mockMatches = bodyText.match(/\b(jest\.mock|vi\.mock|sinon\.stub|mock|mockImplementation)\b/g)
        mockCount = mockMatches ? mockMatches.length : 0
      }

      out.push({
        file,
        line: lineOf(sf, node.getStart(sf)),
        name,
        skipped,
        hasAssertion,
        hasTodo,
        mockCount,
      })
    })
  }
  return out
}

export async function runQaAudit(options: QaAuditOptions = {}): Promise<QaAuditResult> {
  const minSeverity = options.minSeverity ?? "Low"
  const mockThreshold = options.excessiveMocksThreshold ?? 5

  const { source, test } = collectFiles()
  const productionFns = extractProductionFns(source)
  const testCases = extractTestCases(test)

  // Test adlarını birleşik blob olarak indeksle — basit fuzzy match
  const testBlob = testCases.map((t) => t.name.toLowerCase()).join("\n")

  const findings: Finding[] = []

  // prod-without-test
  for (const fn of productionFns) {
    if (fn.name.startsWith("_") || fn.name === "default") continue
    // Çok kısa veya generic adları atla (örn: "get", "set")
    if (fn.name.length < 4) continue
    if (!testBlob.includes(fn.searchKey)) {
      findings.push({
        severity: "Low",
        category: CATEGORY,
        file: fn.file,
        line: fn.line,
        rule: "prod-without-test",
        message: `Fonksiyon '${fn.name}' için eşleşen test bulunamadı.`,
        impact:
          "Test edilmemiş fonksiyon refactor sırasında sessizce kırılabilir; " +
          "regresyon CI tarafından yakalanmaz, prod'da ortaya çıkar.",
        recommendation:
          `'${fn.name}' için bir test spec dosyası ekle. Test adı içinde fonksiyon adını ` +
          "geçir ki bu kural eşleşmeyi yakalasın.",
      })
    }
  }

  // Test-level kurallar
  for (const tc of testCases) {
    if (tc.skipped) {
      findings.push({
        severity: "Medium",
        category: CATEGORY,
        file: tc.file,
        line: tc.line,
        rule: "skipped-test",
        message: `Test '${tc.name}' .skip / xit ile devre dışı.`,
        impact:
          "Skip edilmiş test'ler 'yeşil' CI verir ama hiçbir şey doğrulanmaz; " +
          "kalıcılaşırsa false positive bir kalite metriği üretir.",
        recommendation:
          "Skip'in nedenini issue/TODO ile bağla veya test'i düzelt. Geçici skip için " +
          "satır üstüne kısa gerekçe yorumu ekle.",
      })
    }
    if (!tc.hasAssertion && !tc.skipped) {
      findings.push({
        severity: "High",
        category: CATEGORY,
        file: tc.file,
        line: tc.line,
        rule: "empty-test",
        message: `Test '${tc.name}' hiçbir assertion içermiyor.`,
        impact:
          "Assertion'sız test sadece kodu çalıştırır; doğruluğu kontrol etmez. " +
          "Çağrı yolu kapsamı verir ama davranış garantisi vermez — false coverage.",
        recommendation:
          "expect/assert ile en az bir davranış kontrolü ekle. Smoke test bile sayı/" +
          "şekil kontrolü yapmalı.",
      })
    }
    if (tc.hasTodo) {
      findings.push({
        severity: "Low",
        category: CATEGORY,
        file: tc.file,
        line: tc.line,
        rule: "todo-in-test",
        message: `Test '${tc.name}' içinde TODO/FIXME yorumu var.`,
        impact:
          "TODO'lu testler tamamlanmamış senaryoyu işaretler; unutulursa kapsam eksik kalır.",
        recommendation:
          "TODO'yu çöz veya bir issue'ya bağla, eski hâliyle bırakma.",
      })
    }
    if (tc.mockCount > mockThreshold) {
      findings.push({
        severity: "Medium",
        category: CATEGORY,
        file: tc.file,
        line: tc.line,
        rule: "excessive-mocks",
        message: `Test '${tc.name}' ${tc.mockCount} mock kullanıyor (eşik: ${mockThreshold}).`,
        impact:
          "Aşırı mock kullanımı test'in gerçek davranışı değil, mock'ları doğruladığını gösterir; " +
          "implementation detail'ı sıkı bağlar, refactor'a karşı kırılgan.",
        recommendation:
          "Test edilen birimi daha küçük parçalara ayır veya integration test yaz. " +
          "Mock yerine in-memory fake'ler tercih et.",
      })
    }
  }

  const filtered = findings.filter((f) => meetsMinSeverity(f.severity, minSeverity))
  const enriched = await enrichFindings({ findings: filtered, roleKey: "qa-engineer" })
  enriched.findings.sort((a, b) => compareSeverityDesc(a.severity, b.severity) || a.file.localeCompare(b.file) || a.line - b.line)

  const summary: Record<Lowercase<Severity>, number> = {
    critical: 0, high: 0, medium: 0, low: 0, suggestion: 0,
  }
  const byRule: Record<string, number> = {}
  for (const f of enriched.findings) {
    summary[f.severity.toLowerCase() as Lowercase<Severity>]++
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1
  }

  return {
    productionFnCount: productionFns.length,
    testCount: testCases.length,
    testsAnalyzed: testCases.length,
    summary,
    byRule,
    findings: enriched.findings,
  }
}
