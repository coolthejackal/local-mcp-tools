import ts from "typescript"
import type { Finding } from "../finding"
import type { TsRule } from "../tsRule"
import { lineOf, walk } from "../tsRule"

const emptyCatch: TsRule = {
  name: "empty-catch",
  category: "ErrorHandling",
  check(sf, fileName) {
    const out: Finding[] = []
    walk(sf, (node) => {
      if (ts.isCatchClause(node) && node.block.statements.length === 0) {
        out.push({
          severity: "High",
          category: "ErrorHandling",
          file: fileName,
          line: lineOf(sf, node.getStart(sf)),
          rule: "empty-catch",
          message: "catch bloğu boş — hata sessizce yutuluyor.",
          impact:
            "Sessiz hatalar production'da en zor ayıklanan sınıftır: işlem yarıda kesilir " +
            "ama log/alert üretilmez, veri tutarsızlığı ve gizli regression riski oluşur.",
          recommendation:
            "En az bir log + (gerekiyorsa) yeniden fırlat veya domain-spesifik hata dönüş. " +
            "Boş catch yalnız bilinçli bir 'best-effort' senaryoda kullanılmalı ve yorumla gerekçelendirilmeli.",
        })
      }
    })
    return out
  },
}

const swallowedCatch: TsRule = {
  name: "swallowed-catch",
  category: "ErrorHandling",
  check(sf, fileName) {
    const out: Finding[] = []
    walk(sf, (node) => {
      if (ts.isCatchClause(node)) {
        const stmts = node.block.statements
        if (stmts.length === 0) return

        const onlyLogs = stmts.every((s) => {
          if (!ts.isExpressionStatement(s)) return false
          const e = s.expression
          if (!ts.isCallExpression(e)) return false
          if (!ts.isPropertyAccessExpression(e.expression)) return false
          if (!ts.isIdentifier(e.expression.expression)) return false
          return e.expression.expression.text === "console"
        })

        if (onlyLogs && stmts.length > 0) {
          out.push({
            severity: "High",
            category: "ErrorHandling",
            file: fileName,
            line: lineOf(sf, node.getStart(sf)),
            rule: "swallowed-catch",
            message: "catch bloğu yalnız console.* çağırıyor; hata yutuluyor.",
            impact:
              "console.log production'da güvenilir bir gözlemleme aracı değildir — " +
              "log toplama / alert mekanizmaları bypass edilir, hata observability dışında kalır.",
            recommendation:
              "Yapılandırılmış logger kullan (winston/pino) ve bağlam ekle (correlation id, " +
              "request id). Gerekirse rethrow et veya tipli bir hata dön.",
          })
        }
      }
    })
    return out
  },
}

const catchRethrowsBare: TsRule = {
  name: "catch-rethrows-bare",
  category: "ErrorHandling",
  check(sf, fileName) {
    const out: Finding[] = []
    walk(sf, (node) => {
      if (ts.isCatchClause(node) && node.variableDeclaration) {
        const varName = node.variableDeclaration.name.getText(sf)
        const stmts = node.block.statements
        if (
          stmts.length === 1 &&
          ts.isThrowStatement(stmts[0]) &&
          stmts[0].expression &&
          ts.isIdentifier(stmts[0].expression) &&
          stmts[0].expression.text === varName
        ) {
          out.push({
            severity: "Low",
            category: "ErrorHandling",
            file: fileName,
            line: lineOf(sf, node.getStart(sf)),
            rule: "catch-rethrows-bare",
            message: "catch yakaladığı hatayı olduğu gibi tekrar fırlatıyor.",
            impact:
              "Bu try/catch hiçbir şey katmıyor; stack trace'i bozma riski olmasa da " +
              "okuyucu için kafa karıştırıcı ve dead code işareti.",
            recommendation:
              "try/catch'i kaldır veya yakaladığın hataya bağlam ekle " +
              "(throw new DomainError('...', { cause: e })).",
          })
        }
      }
    })
    return out
  },
}

const promiseNoCatch: TsRule = {
  name: "promise-no-catch",
  category: "ErrorHandling",
  check(sf, fileName) {
    const out: Finding[] = []
    walk(sf, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "then"
      ) {
        const isExpressionStmt =
          node.parent && ts.isExpressionStatement(node.parent)
        const isChainedToCatchOrFinally =
          node.parent &&
          ts.isPropertyAccessExpression(node.parent) &&
          (node.parent.name.text === "catch" || node.parent.name.text === "finally")

        if (isExpressionStmt && !isChainedToCatchOrFinally) {
          out.push({
            severity: "Medium",
            category: "ErrorHandling",
            file: fileName,
            line: lineOf(sf, node.getStart(sf)),
            rule: "promise-no-catch",
            message: ".then(...) sonrası .catch / .finally yok ve sonuç bekleniyor.",
            impact:
              "Promise reject olursa UnhandledPromiseRejection üretir; Node 15+ default " +
              "olarak process'i sonlandırır. Async hata gözlemlenemez.",
            recommendation:
              ".catch(err => ...) ekle veya await ile try/catch içine al.",
          })
        }
      }
    })
    return out
  },
}

const asyncWithoutTry: TsRule = {
  name: "async-without-try",
  category: "ErrorHandling",
  check(sf, fileName) {
    const out: Finding[] = []
    walk(sf, (node) => {
      const isAsyncFn =
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isMethodDeclaration(node)) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)

      if (isAsyncFn && (node as ts.FunctionLikeDeclaration).body) {
        const fn = node as ts.FunctionLikeDeclaration
        let hasAwait = false
        let hasTry = false
        function scan(n: ts.Node) {
          if (ts.isAwaitExpression(n)) hasAwait = true
          if (ts.isTryStatement(n)) hasTry = true
          if (
            ts.isFunctionDeclaration(n) ||
            ts.isFunctionExpression(n) ||
            ts.isArrowFunction(n) ||
            ts.isMethodDeclaration(n)
          ) {
            return
          }
          ts.forEachChild(n, scan)
        }
        if (fn.body) ts.forEachChild(fn.body, scan)

        if (hasAwait && !hasTry) {
          const name =
            (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name
              ? node.name.getText(sf)
              : "(anonim)"
          out.push({
            severity: "Medium",
            category: "ErrorHandling",
            file: fileName,
            line: lineOf(sf, node.getStart(sf)),
            rule: "async-without-try",
            message: `Async fonksiyon '${name}' await içeriyor ama try/catch yok.`,
            impact:
              "await'ten gelen reject çağıran fonksiyona kadar yayılır; ara katmanda " +
              "loglanmaz, retry/idempotency uygulanamaz, kullanıcıya jenerik hata döner.",
            recommendation:
              "Kritik await'leri try/catch'e al, bağlam ekleyerek logla ve uygun " +
              "domain hata tipi ile rethrow et veya fallback değer dön.",
          })
        }
      }
    })
    return out
  },
}

export const ERROR_HANDLING_RULES: TsRule[] = [
  emptyCatch,
  swallowedCatch,
  catchRethrowsBare,
  promiseNoCatch,
  asyncWithoutTry,
]
