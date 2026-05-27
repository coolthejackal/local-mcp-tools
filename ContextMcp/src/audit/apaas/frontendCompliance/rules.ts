import ts from "typescript"
import type { Finding } from "../../shared/finding"
import { lineOf, walk } from "../../../review/tsRule"

// İstisna sözdizimi: dosya başında veya kural satırının HEMEN üstünde
//   // @frontend-compliance-allow: <rule-name> — <gerekçe>
// satırı varsa o kural o dosya/satır için bastırılır.

function getAllowedRules(sf: ts.SourceFile): Set<string> {
  const allowed = new Set<string>()
  const text = sf.text
  const re = /\/\/\s*@frontend-compliance-allow:\s*([a-z0-9,\-\s]+)/gi
  let match
  while ((match = re.exec(text)) !== null) {
    const list = match[1].split(/[,\s]+/).filter(Boolean)
    for (const r of list) allowed.add(r)
  }
  return allowed
}

function isLineAllowed(sf: ts.SourceFile, line: number, rule: string): boolean {
  // Önceki satırdaki yorum
  const lines = sf.text.split(/\r?\n/)
  const prev = lines[line - 2] ?? ""
  const re = /\/\/\s*@frontend-compliance-allow:\s*([a-z0-9,\-\s]+)/i
  const m = prev.match(re)
  if (!m) return false
  return m[1].split(/[,\s]+/).filter(Boolean).includes(rule)
}

function makeFinding(
  severity: Finding["severity"],
  category: string,
  rule: string,
  sf: ts.SourceFile,
  node: ts.Node,
  message: string,
  impact: string,
  recommendation: string
): Finding {
  return {
    severity,
    category,
    file: sf.fileName,
    line: lineOf(sf, node.getStart(sf)),
    rule,
    message,
    impact,
    recommendation,
  }
}

// ─── interceptor: direct-axios ──────────────────────────────────────────────
export function detectDirectAxios(sf: ts.SourceFile): Finding[] {
  const out: Finding[] = []
  const allowed = getAllowedRules(sf)

  // `import axios from "axios"` — default import edilmiş axios kullanımı yasak.
  // Ama axios bazı yerlerde alt path'lerden gelebilir; bunlar createApiClient içinde.
  let importsAxiosDefault = false
  walk(sf, (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "axios" &&
      node.importClause &&
      node.importClause.name  // default import
    ) {
      importsAxiosDefault = true
    }
  })

  // axios.get/post/... çağrıları
  walk(sf, (node) => {
    if (!ts.isCallExpression(node)) return
    if (!ts.isPropertyAccessExpression(node.expression)) return
    if (!ts.isIdentifier(node.expression.expression)) return
    if (node.expression.expression.text !== "axios") return

    const method = node.expression.name.text
    if (!["get", "post", "put", "delete", "patch", "request"].includes(method)) return

    const rule = "direct-axios-call"
    if (allowed.has(rule) || isLineAllowed(sf, lineOf(sf, node.getStart(sf)), rule)) return

    out.push(makeFinding(
      "High",
      "interceptor",
      rule,
      sf, node,
      `axios.${method}(...) doğrudan çağrılıyor — interceptor bypass.`,
      "Global axios kullanmak createApiClient/authAxios interceptor'larını atlatır; " +
      "401 silent refresh, 5xx ErrorModal, 429 throttle UI'si devre dışı kalır. " +
      "Hata gözlemlenmez, kullanıcı tutarsız davranış görür.",
      "createApiClient(accessToken).<method>(...) kullan. " +
      "Auth endpoint'leri için authAxios import et. " +
      "İstisna gerekiyorsa // @frontend-compliance-allow: direct-axios-call — <gerekçe>"
    ))
  })

  // Sadece default import edilmiş ama hiç kullanılmamış olsa bile uyarı verme — kullanıma odaklan.
  void importsAxiosDefault
  return out
}

// ─── dx-wrapper: native HTML form elements ──────────────────────────────────
const NATIVE_FORM_ELEMENTS = new Set(["input", "select", "textarea"])

export function detectNativeFormElements(sf: ts.SourceFile): Finding[] {
  const out: Finding[] = []
  const allowed = getAllowedRules(sf)

  walk(sf, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
    const tagName = node.tagName
    if (!ts.isIdentifier(tagName)) return  // büyük harfli komponentler PropertyAccessName olmaz; native ise küçük harfli identifier
    const name = tagName.text
    if (!NATIVE_FORM_ELEMENTS.has(name)) return

    const rule = "native-html-form-element"
    if (allowed.has(rule)) return
    const line = lineOf(sf, node.getStart(sf))
    if (isLineAllowed(sf, line, rule)) return

    out.push(makeFinding(
      "Medium",
      "dx-wrapper",
      rule,
      sf, node,
      `<${name}> native HTML elemanı kullanılıyor.`,
      "Native form elemanları VariantRegistry styling, Field Policy DSL ve a11y " +
      "düzeltmelerini bypass eder. Form genelinde tutarsız UX ve test edilemeyen " +
      "kontrol davranışı oluşur.",
      `<Dx${name[0].toUpperCase() + name.slice(1)}> wrapper'ını kullan (src/components/dx/). ` +
      `İstisna (örn. ADR-021 native input gerekçesi): satır üstüne ` +
      `// @frontend-compliance-allow: ${rule} — <gerekçe> yaz.`
    ))
  })

  // <button type="submit"> — submit'i DxButton ile yapmak isteniyor
  walk(sf, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
    const tagName = node.tagName
    if (!ts.isIdentifier(tagName)) return
    if (tagName.text !== "button") return

    // type="submit" attribute'u
    const hasSubmitType = node.attributes.properties.some((p) => {
      if (!ts.isJsxAttribute(p)) return false
      if (!ts.isIdentifier(p.name) || p.name.text !== "type") return false
      const init = p.initializer
      if (!init) return false
      if (ts.isStringLiteral(init)) return init.text === "submit"
      return false
    })
    if (!hasSubmitType) return

    const rule = "native-html-form-element"
    if (allowed.has(rule)) return
    const line = lineOf(sf, node.getStart(sf))
    if (isLineAllowed(sf, line, rule)) return

    out.push(makeFinding(
      "Medium",
      "dx-wrapper",
      rule,
      sf, node,
      `<button type="submit"> native — DxButton wrapper'ı tercih edilir.`,
      "DX wrapper styling/disabled-state/loading-state'i merkezîleştirir; " +
      "native button kullanımı form süreçlerinde UX tutarsızlığı yaratır.",
      "<DxButton stylingMode='contained' type='success' useSubmitBehavior /> kullan."
    ))
  })

  return out
}

// ─── error-handling: manual toast on intercepted statuses ────────────────────
const HANDLED_STATUSES = new Set([401, 403, 423, 429])

export function detectManualToastOnInterceptedStatus(sf: ts.SourceFile): Finding[] {
  const out: Finding[] = []
  const allowed = getAllowedRules(sf)

  // catch içinde toast/notify/showError çağrısı + status >= 500 kontrolü veya HANDLED_STATUSES sayısı
  walk(sf, (node) => {
    if (!ts.isCatchClause(node)) return

    // Catch body içinde toast/notify çağrısı var mı?
    let toastCalled = false
    let statusComparison: number | "gte500" | null = null

    const visitInside = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const expr = n.expression
        if (ts.isIdentifier(expr) && /^(toast|notify|showError|showWarning)$/i.test(expr.text)) {
          toastCalled = true
        }
        if (ts.isPropertyAccessExpression(expr) && /^(toast|notify|showError)$/i.test(expr.name.text)) {
          toastCalled = true
        }
      }
      // status === 401 / status >= 500 / status === 429
      if (ts.isBinaryExpression(n)) {
        const opKind = n.operatorToken.kind
        const left = n.left.getText(sf)
        const right = n.right.getText(sf)
        if (/\bstatus\b/.test(left) || /\bstatusCode\b/.test(left)) {
          if (opKind === ts.SyntaxKind.EqualsEqualsEqualsToken || opKind === ts.SyntaxKind.EqualsEqualsToken) {
            const num = Number(right)
            if (HANDLED_STATUSES.has(num)) statusComparison = num
          } else if (opKind === ts.SyntaxKind.GreaterThanEqualsToken && right === "500") {
            statusComparison = "gte500"
          }
        }
      }
      ts.forEachChild(n, visitInside)
    }
    ts.forEachChild(node.block, visitInside)

    if (toastCalled && statusComparison !== null) {
      const rule = "manual-toast-on-intercepted-status"
      if (allowed.has(rule)) return
      const line = lineOf(sf, node.getStart(sf))
      if (isLineAllowed(sf, line, rule)) return

      out.push(makeFinding(
        "Medium",
        "error-handling",
        rule,
        sf, node,
        `catch içinde 5xx/401/429 için manuel toast — interceptor zaten gösteriyor.`,
        "Interceptor yapılandırılmış pattern'lerle (silent refresh, ErrorModal, " +
        "throttle toast) bu statüleri yönetir. Sayfa-level toast eklemek " +
        "çift bildirim üretir, kullanıcıyı şaşırtır, ekibin debug'ını zorlaştırır.",
        "Bu statüler için catch'i sessiz bırak veya yalnız 4xx (400/404/409/422) " +
        "validation mesajları için manuel toast kullan."
      ))
    }
  })

  return out
}

// ─── dx-wrapper: missing loading state (heuristic) ────────────────────────
export function detectMissingLoadingState(sf: ts.SourceFile): Finding[] {
  const out: Finding[] = []
  const allowed = getAllowedRules(sf)

  // useEffect içinde await olan ama dosyada isLoading/loading state'i olmayan komponent.
  // Heuristic — sadece dosya seviyesinde bakar, %100 doğru değil.
  let hasAwaitInEffect = false
  let hasLoadingState = false

  walk(sf, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "useEffect") {
        // İçeride await veya .then var mı?
        const visitInside = (n: ts.Node): void => {
          if (ts.isAwaitExpression(n)) hasAwaitInEffect = true
          ts.forEachChild(n, visitInside)
        }
        for (const arg of node.arguments) visitInside(arg)
      }
      if (node.expression.text === "useState") {
        const arg = node.arguments[0]?.getText(sf) ?? ""
        if (/loading|isLoading|loading\s*[:=]/i.test(arg)) hasLoadingState = true
      }
    }
  })

  if (hasAwaitInEffect && !hasLoadingState) {
    const rule = "missing-loading-state"
    if (allowed.has(rule)) return out
    out.push({
      severity: "Low",
      category: "dx-wrapper",
      file: sf.fileName,
      line: 1,
      rule,
      message: "useEffect içinde async iş yapan komponent loading state tutmuyor.",
      impact: "Kullanıcı veri yüklenirken boş/eski içerik görür; double-click sorunları, " +
              "spinner eksikliği UX kalitesini düşürür.",
      recommendation: "useState ile isLoading state'i tut, yükleme sırasında DX " +
                      "bileşeninin loading prop'unu set et veya spinner göster. " +
                      `İstisna: // @frontend-compliance-allow: ${rule}`,
    })
  }

  return out
}

// ─── dispatcher ──────────────────────────────────────────────────────────────
export function runAllRules(sf: ts.SourceFile, categories?: string[]): Finding[] {
  const all: Finding[] = []
  const inCat = (cat: string) => !categories || categories.length === 0 || categories.includes(cat)

  if (inCat("interceptor")) all.push(...detectDirectAxios(sf))
  if (inCat("dx-wrapper")) {
    all.push(...detectNativeFormElements(sf))
    all.push(...detectMissingLoadingState(sf))
  }
  if (inCat("error-handling")) all.push(...detectManualToastOnInterceptedStatus(sf))

  return all
}
