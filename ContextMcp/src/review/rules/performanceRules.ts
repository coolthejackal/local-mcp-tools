import ts from "typescript"
import type { Finding } from "../finding"
import type { TsRule } from "../tsRule"
import { lineOf, walk, isInsideLoop, enclosingAsyncFunction, isInsideTry } from "../tsRule"

const awaitInLoop: TsRule = {
  name: "await-in-loop",
  category: "Performance",
  check(sf, fileName) {
    const out: Finding[] = []
    walk(sf, (node) => {
      if (ts.isAwaitExpression(node) && isInsideLoop(node)) {
        out.push({
          severity: "High",
          category: "Performance",
          file: fileName,
          line: lineOf(sf, node.getStart(sf)),
          rule: "await-in-loop",
          message: "await ifadesi döngü içinde sıralı çalıştırılıyor.",
          impact:
            "Her iterasyon bir öncekini bekler — N istek için toplam gecikme N×t olur. " +
            "Klasik N+1 problemi; HTTP/DB çağrılarında throughput'u dramatik düşürür.",
          recommendation:
            "Bağımsız iterasyonlar için Promise.all(items.map(fn)) kullan. " +
            "Sıra önemliyse batch'le veya for-await-of with controlled concurrency (p-limit) uygula.",
        })
      }
    })
    return out
  },
}

const SYNC_FS_METHODS = new Set([
  "readFileSync",
  "writeFileSync",
  "appendFileSync",
  "readdirSync",
  "statSync",
  "existsSync",
  "unlinkSync",
  "mkdirSync",
  "rmSync",
  "copyFileSync",
])

const syncFsInAsync: TsRule = {
  name: "sync-fs-in-async",
  category: "Performance",
  check(sf, fileName) {
    const out: Finding[] = []
    walk(sf, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        SYNC_FS_METHODS.has(node.expression.name.text) &&
        enclosingAsyncFunction(node)
      ) {
        out.push({
          severity: "High",
          category: "Performance",
          file: fileName,
          line: lineOf(sf, node.getStart(sf)),
          rule: "sync-fs-in-async",
          message: `Async fonksiyon içinde senkron fs çağrısı: ${node.expression.name.text}.`,
          impact:
            "Senkron fs çağrısı event loop'u bloklar; Node.js sunucuda tüm istekleri durdurur. " +
            "Throughput ve latency P99 ciddi etkilenir.",
          recommendation:
            "fs/promises'ten async versiyonu kullan: " +
            "import { readFile } from 'fs/promises'; await readFile(...).",
        })
      }
    })
    return out
  },
}

const stringConcatInLoop: TsRule = {
  name: "string-concat-in-loop",
  category: "Performance",
  check(sf, fileName) {
    const out: Finding[] = []
    walk(sf, (node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
        isInsideLoop(node)
      ) {
        out.push({
          severity: "Medium",
          category: "Performance",
          file: fileName,
          line: lineOf(sf, node.getStart(sf)),
          rule: "string-concat-in-loop",
          message: "Döngü içinde += ile (büyük olasılıkla string) birikim yapılıyor.",
          impact:
            "JS string'leri immutable; her += yeni allocation yapar — büyük girdilerde O(N²) " +
            "bellek/CPU maliyeti üretir.",
          recommendation:
            "Parçaları bir array'e push edip sonunda .join('') kullan, " +
            "veya stream/template tabanlı yaklaşımı değerlendir.",
        })
      }
    })
    return out
  },
}

const regexInLoop: TsRule = {
  name: "regex-in-loop",
  category: "Performance",
  check(sf, fileName) {
    const out: Finding[] = []
    walk(sf, (node) => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "RegExp" &&
        isInsideLoop(node)
      ) {
        out.push({
          severity: "Medium",
          category: "Performance",
          file: fileName,
          line: lineOf(sf, node.getStart(sf)),
          rule: "regex-in-loop",
          message: "Döngü içinde new RegExp() ile regex compile ediliyor.",
          impact:
            "Her iterasyonda regex yeniden compile edilir; büyük N'de gereksiz CPU yakar.",
          recommendation:
            "Regex'i döngü dışında bir kez oluştur ve referansını kullan: " +
            "const RX = /.../; for (...) { RX.test(x) }.",
        })
      }
    })
    return out
  },
}

const jsonParseNoTry: TsRule = {
  name: "json-parse-no-try",
  category: "Performance",
  check(sf, fileName) {
    const out: Finding[] = []
    walk(sf, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "JSON" &&
        node.expression.name.text === "parse" &&
        !isInsideTry(node)
      ) {
        out.push({
          severity: "Low",
          category: "Performance",
          file: fileName,
          line: lineOf(sf, node.getStart(sf)),
          rule: "json-parse-no-try",
          message: "JSON.parse try/catch dışında çağrılıyor.",
          impact:
            "Geçersiz JSON SyntaxError fırlatır; yakalanmazsa request thread / promise " +
            "unhandled rejection ile sonlanır, kullanıcıya 500 döner.",
          recommendation:
            "JSON.parse çağrısını try/catch'e al ve fail durumunda anlamlı bir " +
            "validation hatası dön (400 Bad Request gibi).",
        })
      }
    })
    return out
  },
}

export const PERFORMANCE_RULES: TsRule[] = [
  awaitInLoop,
  syncFsInAsync,
  stringConcatInLoop,
  regexInLoop,
  jsonParseNoTry,
]
