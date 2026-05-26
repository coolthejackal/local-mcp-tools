import ts from "typescript"
import type { Finding } from "../finding"
import type { TsRule } from "../tsRule"
import { lineOf, walk } from "../tsRule"

const SECRET_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /AKIA[0-9A-Z]{16}/, label: "AWS access key" },
  { regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, label: "private key (PEM)" },
  { regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, label: "JWT token" },
  { regex: /(?:password|passwd|pwd|api[_-]?key|secret|token)\s*[:=]\s*['"][^'"\s]{6,}['"]/i, label: "credential literal" },
  { regex: /(?:mongodb|postgres|postgresql|mysql|mssql|redis):\/\/[^\s'"<>]+:[^\s'"<>]+@/i, label: "DB connection string with credentials" },
]

const hardcodedSecret: TsRule = {
  name: "hardcoded-secret",
  category: "Security",
  check(sf, fileName) {
    const out: Finding[] = []
    walk(sf, (node) => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        const text = node.text
        for (const { regex, label } of SECRET_PATTERNS) {
          if (regex.test(text)) {
            out.push({
              severity: "Critical",
              category: "Security",
              file: fileName,
              line: lineOf(sf, node.getStart(sf)),
              rule: "hardcoded-secret",
              message: `Olası hardcoded ${label} string literal içinde.`,
              impact:
                "Repo'ya commit edilen sırlar git history'sinde kalır; ihlali geri alınamaz, " +
                "credential rotasyonu ve incident response gerektirir.",
              recommendation:
                "Sırrı environment variable veya secret manager'a taşı (örn: process.env.X, " +
                "AWS Secrets Manager, Vault). Repo'dan kaldırıp anahtarı rotate et.",
            })
            break
          }
        }
      }
    })
    return out
  },
}

const SQL_KEYWORD = /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|UNION|DROP|ALTER|TRUNCATE)\b/i

const sqlInjection: TsRule = {
  name: "sql-injection",
  category: "Security",
  check(sf, fileName) {
    const out: Finding[] = []
    walk(sf, (node) => {
      if (ts.isTemplateExpression(node)) {
        const headText = node.head.text
        const allText =
          headText + node.templateSpans.map((s) => s.literal.text).join(" ")
        if (SQL_KEYWORD.test(allText) && node.templateSpans.length > 0) {
          out.push({
            severity: "Critical",
            category: "Security",
            file: fileName,
            line: lineOf(sf, node.getStart(sf)),
            rule: "sql-injection",
            message: "Template literal SQL anahtar kelimesi içeriyor ve interpolasyon yapıyor.",
            impact:
              "Kullanıcı girdisinin SQL'e birleştirilmesi injection açar; " +
              "yetkisiz veri okuma, silme veya tüm tablo dökümünü mümkün kılar.",
            recommendation:
              "Parametrik sorgu kullan: pg/mysql2 `?`/`$1` placeholder'ları, " +
              "Prisma/TypeORM parameterized queries veya stored procedure. " +
              "Sorgu içeriği kullanıcıdan gelmemeli.",
          })
        }
      }

      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = node.left.getText(sf)
        const right = node.right.getText(sf)
        const combined = `${left} ${right}`
        if (SQL_KEYWORD.test(combined) && (left.includes('"') || left.includes("'") || right.includes('"') || right.includes("'"))) {
          if (!ts.isStringLiteralLike(node.left) || !ts.isStringLiteralLike(node.right)) {
            out.push({
              severity: "Critical",
              category: "Security",
              file: fileName,
              line: lineOf(sf, node.getStart(sf)),
              rule: "sql-injection",
              message: "SQL sorgusu string concatenation (+) ile değişken birleştiriyor.",
              impact:
                "String concat ile inşa edilen SQL injection açar; yetkisiz erişim ve veri kaybı riski.",
              recommendation:
                "Parametrik sorgu (placeholder) kullan veya ORM'in parametre bağlama API'sini kullan.",
            })
          }
        }
      }
    })
    return out
  },
}

const xssSink: TsRule = {
  name: "xss-sink",
  category: "Security",
  check(sf, fileName) {
    const out: Finding[] = []
    walk(sf, (node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.name.text === "innerHTML" &&
        !ts.isStringLiteral(node.right)
      ) {
        out.push({
          severity: "High",
          category: "Security",
          file: fileName,
          line: lineOf(sf, node.getStart(sf)),
          rule: "xss-sink",
          message: "innerHTML'e statik olmayan değer atanıyor.",
          impact:
            "Kullanıcı kontrolündeki içerik innerHTML'e yazılırsa stored/reflected XSS açar; " +
            "session hijack, credential theft, defacement mümkün olur.",
          recommendation:
            "textContent kullan veya DOMPurify gibi sanitizer'dan geçir. " +
            "React'te dangerouslySetInnerHTML yerine JSX kullan.",
        })
      }

      if (
        ts.isJsxAttribute(node) &&
        node.name.getText(sf) === "dangerouslySetInnerHTML"
      ) {
        out.push({
          severity: "High",
          category: "Security",
          file: fileName,
          line: lineOf(sf, node.getStart(sf)),
          rule: "xss-sink",
          message: "JSX'te dangerouslySetInnerHTML kullanılıyor.",
          impact:
            "React'in XSS koruması bypass edilir; içerik sanitize edilmezse XSS açar.",
          recommendation:
            "Mümkünse JSX kullan. Zorunluysa DOMPurify ile sanitize et ve yorumda gerekçesini açıkla.",
        })
      }
    })
    return out
  },
}

const weakCrypto: TsRule = {
  name: "weak-crypto",
  category: "Security",
  check(sf, fileName) {
    const out: Finding[] = []
    walk(sf, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "createHash" &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const algo = node.arguments[0].text.toLowerCase()
        if (algo === "md5" || algo === "sha1") {
          out.push({
            severity: "High",
            category: "Security",
            file: fileName,
            line: lineOf(sf, node.getStart(sf)),
            rule: "weak-crypto",
            message: `Zayıf hash algoritması: ${algo.toUpperCase()}.`,
            impact:
              "MD5/SHA1 collision saldırılarına açık; password/integrity için kullanılırsa " +
              "preimage bulma ve manipülasyon mümkündür.",
            recommendation:
              "SHA-256 veya SHA-512 kullan (createHash('sha256')). Şifre hashleme için " +
              "bcrypt/scrypt/argon2id tercih et.",
          })
        }
      }
    })
    return out
  },
}

const unsafeEval: TsRule = {
  name: "unsafe-eval",
  category: "Security",
  check(sf, fileName) {
    const out: Finding[] = []
    walk(sf, (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval") {
        out.push({
          severity: "Critical",
          category: "Security",
          file: fileName,
          line: lineOf(sf, node.getStart(sf)),
          rule: "unsafe-eval",
          message: "eval() kullanılıyor.",
          impact:
            "eval() kullanıcı girdisini çalıştırırsa keyfi kod yürütme (RCE) açar; " +
            "ayrıca optimizer'ları engeller ve scope analizini bozar.",
          recommendation:
            "JSON.parse, Function constructor (sınırlı senaryolarda), parser kütüphanesi " +
            "veya tasarımı yeniden değerlendir — kullanıcı girdisi eval edilmemeli.",
        })
      }

      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
        out.push({
          severity: "Critical",
          category: "Security",
          file: fileName,
          line: lineOf(sf, node.getStart(sf)),
          rule: "unsafe-eval",
          message: "new Function() ile dinamik kod yürütülüyor.",
          impact:
            "eval ile aynı RCE riski. Kullanıcı girdisi Function constructor'a geçerse " +
            "keyfi kod yürütülür.",
          recommendation:
            "Dinamik mantığı static dispatch (switch/map) ile değiştir veya güvenli sandbox kullan.",
        })
      }
    })
    return out
  },
}

export const SECURITY_RULES: TsRule[] = [
  hardcodedSecret,
  sqlInjection,
  xssSink,
  weakCrypto,
  unsafeEval,
]
