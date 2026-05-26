import ts from "typescript"
import type { Finding } from "../finding"
import type { TsRule } from "../tsRule"
import { lineOf, walk, countLines } from "../tsRule"

const GOD_CLASS_LINES = 500
const GOD_CLASS_METHODS = 20
const LONG_FUNCTION_LINES = 100
const TOO_MANY_PARAMS = 5
const MAX_NESTING_DEPTH = 4

const godClass: TsRule = {
  name: "god-class",
  category: "Architecture",
  check(sf, fileName) {
    const out: Finding[] = []
    walk(sf, (node) => {
      if (ts.isClassDeclaration(node) && node.name) {
        const lines = countLines(sf, node.getStart(sf), node.getEnd())
        const methods = node.members.filter(
          (m) => ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)
        ).length

        if (lines > GOD_CLASS_LINES || methods > GOD_CLASS_METHODS) {
          out.push({
            severity: "Medium",
            category: "Architecture",
            file: fileName,
            line: lineOf(sf, node.getStart(sf)),
            rule: "god-class",
            message: `Sınıf '${node.name.text}' çok büyük: ${lines} satır, ${methods} üye.`,
            impact:
              "God class SRP'yi (Single Responsibility) ihlal eder; test edilmesi, " +
              "anlaşılması ve değiştirilmesi zorlaşır. Merge çakışmaları artar, yan etkiler izlenemez.",
            recommendation:
              "Sınıfı sorumluluğa göre böl (örn: validator, repository, mapper). " +
              "Method gruplarını ayrı modüllere taşı; composition tercih et.",
          })
        }
      }
    })
    return out
  },
}

const longFunction: TsRule = {
  name: "long-function",
  category: "Architecture",
  check(sf, fileName) {
    const out: Finding[] = []
    walk(sf, (node) => {
      const isFn =
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node)
      if (isFn && (node as ts.FunctionLikeDeclaration).body) {
        const lines = countLines(sf, node.getStart(sf), node.getEnd())
        if (lines > LONG_FUNCTION_LINES) {
          const name =
            (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name
              ? node.name.getText(sf)
              : "(anonim)"
          out.push({
            severity: "Medium",
            category: "Architecture",
            file: fileName,
            line: lineOf(sf, node.getStart(sf)),
            rule: "long-function",
            message: `Fonksiyon '${name}' ${lines} satır — uzun.`,
            impact:
              "Uzun fonksiyonlar tek seferde anlaşılamaz; cyclomatic complexity yüksek olur, " +
              "test coverage zayıflar ve regresyon riski artar.",
            recommendation:
              "Mantıksal bloklara göre yardımcı fonksiyonlara ayır. " +
              "Her fonksiyonun tek bir 'amacı' olmalı (extract method refactoring).",
          })
        }
      }
    })
    return out
  },
}

const tooManyParams: TsRule = {
  name: "too-many-params",
  category: "Architecture",
  check(sf, fileName) {
    const out: Finding[] = []
    walk(sf, (node) => {
      const isFn =
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isConstructorDeclaration(node)
      if (isFn) {
        const params = (node as ts.SignatureDeclaration).parameters
        if (params && params.length > TOO_MANY_PARAMS) {
          const name =
            (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name
              ? node.name.getText(sf)
              : ts.isConstructorDeclaration(node)
                ? "constructor"
                : "(anonim)"
          out.push({
            severity: "Low",
            category: "Architecture",
            file: fileName,
            line: lineOf(sf, node.getStart(sf)),
            rule: "too-many-params",
            message: `'${name}' ${params.length} parametre alıyor.`,
            impact:
              "Çok sayıda parametre data clump / feature envy sinyalidir; " +
              "çağrı noktalarında hata yapma olasılığı artar (yanlış sırada parametre).",
            recommendation:
              "İlişkili parametreleri tek bir options object / DTO içinde grupla, " +
              "veya sorumluluğu bölmek için fonksiyonu refactor et.",
          })
        }
      }
    })
    return out
  },
}

const deepNesting: TsRule = {
  name: "deep-nesting",
  category: "Architecture",
  check(sf, fileName) {
    const out: Finding[] = []
    const reported = new Set<number>()

    function visit(node: ts.Node, depth: number) {
      const isNester =
        ts.isIfStatement(node) ||
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node) ||
        ts.isTryStatement(node) ||
        ts.isSwitchStatement(node)

      const nextDepth = isNester ? depth + 1 : depth

      if (isNester && nextDepth > MAX_NESTING_DEPTH) {
        const startLine = lineOf(sf, node.getStart(sf))
        if (!reported.has(startLine)) {
          reported.add(startLine)
          out.push({
            severity: "Medium",
            category: "Architecture",
            file: fileName,
            line: startLine,
            rule: "deep-nesting",
            message: `İç içe geçme derinliği ${nextDepth} (eşik: ${MAX_NESTING_DEPTH}).`,
            impact:
              "Derin iç içe yapılar okunabilirliği bozar, control flow'u takip etmeyi zorlaştırır " +
              "ve test edilemeyen edge case'ler üretir.",
            recommendation:
              "Early return / guard clause kullan, alt mantıkları ayrı fonksiyona çıkar, " +
              "veya state machine yaklaşımı değerlendir.",
          })
        }
      }

      ts.forEachChild(node, (child) => visit(child, nextDepth))
    }

    visit(sf, 0)
    return out
  },
}

const publicMutableState: TsRule = {
  name: "public-mutable-state",
  category: "Architecture",
  check(sf, fileName) {
    const out: Finding[] = []
    walk(sf, (node) => {
      if (
        ts.isVariableStatement(node) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
        (node.declarationList.flags & ts.NodeFlags.Const) === 0
      ) {
        out.push({
          severity: "Medium",
          category: "Architecture",
          file: fileName,
          line: lineOf(sf, node.getStart(sf)),
          rule: "public-mutable-state",
          message: "Mutable global state export ediliyor (let/var).",
          impact:
            "Mutable global state test izolasyonunu bozar, race condition'a açıktır, " +
            "modüller arası gizli bağımlılık üretir ve hot reload sırasında tutarsızlık yapar.",
          recommendation:
            "Değişmez (const) tutmaya çalış; durum gerekiyorsa state'i bir sınıf/closure içine al " +
            "ve okuma/yazma için API expose et.",
        })
      }
    })
    return out
  },
}

export const ARCHITECTURE_RULES: TsRule[] = [
  godClass,
  longFunction,
  tooManyParams,
  deepNesting,
  publicMutableState,
]
