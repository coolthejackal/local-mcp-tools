import type { Finding } from "../../shared/finding"
import type { Endpoint } from "./types"
import {
  type PostmanEndpoint,
  normalizeCodeRoute,
  routesMatch,
} from "../../shared/postmanParser"

const CATEGORY = "ApiContract"

function makeFinding(
  severity: Finding["severity"],
  rule: string,
  endpoint: Pick<Endpoint, "file" | "line" | "method" | "route">,
  message: string,
  impact: string,
  recommendation: string
): Finding {
  return {
    severity,
    category: CATEGORY,
    file: endpoint.file,
    line: endpoint.line,
    rule,
    message,
    impact,
    recommendation,
  }
}

export function detectAuthIssues(endpoints: Endpoint[]): Finding[] {
  const findings: Finding[] = []
  for (const ep of endpoints) {
    if (ep.auth === null) {
      findings.push(makeFinding(
        "High",
        "endpoint-no-auth",
        ep,
        `${ep.method} ${ep.route} — auth attribute/middleware yok.`,
        "Kimlik doğrulamasız endpoint anonim trafiğe açıktır; veri sızıntısı, " +
        "yetkisiz iş emri, IDOR riski.",
        "Endpoint'i .RequireAuthorization(Policy) veya [Authorize] ile koru. " +
        "Bilinçli olarak public ise .AllowAnonymous() / [AllowAnonymous] ile niyetini ifade et."
      ))
    } else if (ep.auth === "anonymous") {
      findings.push(makeFinding(
        "Suggestion",
        "endpoint-anonymous-no-justification",
        ep,
        `${ep.method} ${ep.route} — public endpoint (gerekçe yorumu önerilir).`,
        "Public endpoint bilinçliyse yorum, gözden geçirme ve güvenlik analizini kolaylaştırır.",
        "Endpoint hemen üstüne kısa bir gerekçe yorumu ekle (örn: '// Public — health probe')."
      ))
    }
  }
  return findings
}

export function detectMissingCancellationToken(endpoints: Endpoint[]): Finding[] {
  const findings: Finding[] = []
  for (const ep of endpoints) {
    if (ep.hasCancellationToken) continue
    findings.push(makeFinding(
      "Medium",
      "endpoint-missing-cancellation-token",
      ep,
      `${ep.method} ${ep.route} — handler CancellationToken almıyor.`,
      "İptal edilemeyen handler'lar uzun süren işleri kullanıcı bağlantı koparınca veya " +
      "host shutdown'da kibarca durduramaz; thread pool ve DB connection sızıntısı yapar.",
      "Handler imzasına `CancellationToken ct = default` ekle ve aşağıya geçir " +
      "(HttpClient, DbContext, Stream API'lerinin tümü destekler)."
    ))
  }
  return findings
}

export type PostmanDriftFindings = {
  missingInPostman: Finding[]
  orphanInPostman: Finding[]
  routeMismatch: Finding[]
}

export function detectPostmanDrift(
  endpoints: Endpoint[],
  postmanEndpoints: PostmanEndpoint[]
): PostmanDriftFindings {
  const missingInPostman: Finding[] = []
  const orphanInPostman: Finding[] = []
  const routeMismatch: Finding[] = []

  // Eşleşme indeksi
  const matchedPostmanIdx = new Set<number>()

  for (const ep of endpoints) {
    const codeRoute = normalizeCodeRoute(ep.route)
    let matched = false
    let nearMiss: { idx: number; pm: PostmanEndpoint } | null = null

    for (let i = 0; i < postmanEndpoints.length; i++) {
      const pm = postmanEndpoints[i]
      if (pm.method !== ep.method) continue
      if (routesMatch(codeRoute, pm.route)) {
        matched = true
        matchedPostmanIdx.add(i)
        break
      }
      // Aynı path-tail'i içeren bir route varsa "near miss" — route-mismatch kandidatı
      if (!nearMiss && (codeRoute.endsWith(pm.route) || pm.route.endsWith(codeRoute))) {
        nearMiss = { idx: i, pm }
      }
    }

    if (!matched) {
      if (nearMiss) {
        matchedPostmanIdx.add(nearMiss.idx)
        routeMismatch.push(makeFinding(
          "High",
          "endpoint-route-mismatch",
          ep,
          `${ep.method} ${codeRoute} ↔ Postman: ${nearMiss.pm.method} ${nearMiss.pm.route} — benzer ama farklı.`,
          "Postman koleksiyonu kod ile uyuşmuyor; geliştiriciler eski URL'i çağırıyor olabilir.",
          "Postman item'ını güncelle veya endpoint route'unu eski sürümle uyumlu hâle getir."
        ))
      } else {
        missingInPostman.push(makeFinding(
          "Medium",
          "endpoint-missing-in-postman",
          ep,
          `${ep.method} ${codeRoute} — kodda var, Postman koleksiyonunda yok.`,
          "Yeni endpoint Postman'e eklenmediği için ekip manuel test edemiyor, " +
          "release notes'ta görünmüyor, dış paydaşlara yansıtılamıyor.",
          "Postman koleksiyonuna yeni item ekle (`docs/postman/OneFlow.postman_collection.json`)."
        ))
      }
    }
  }

  // Postman'de olup eşleşmeyen item'ler — kodda silinmiş ama Postman güncellenmemiş
  for (let i = 0; i < postmanEndpoints.length; i++) {
    if (matchedPostmanIdx.has(i)) continue
    const pm = postmanEndpoints[i]
    orphanInPostman.push({
      severity: "Low",
      category: CATEGORY,
      file: "(postman)",
      line: 0,
      rule: "endpoint-orphan-in-postman",
      message: `Postman item '${pm.name}' (${pm.method} ${pm.route}) — kodda eşleşen endpoint yok.`,
      impact: "Eski endpoint'ler Postman'de kalırsa yeni geliştiriciler yanlış URL'lerle " +
              "test eder, dökümante edilmiş kontrat ile gerçek kontrat ayrışır.",
      recommendation: "Postman item'ını sil veya 'archived' folder'ına taşı.",
    })
  }

  return { missingInPostman, orphanInPostman, routeMismatch }
}
