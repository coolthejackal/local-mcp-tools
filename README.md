# MCPTools

Claude Code için yerel MCP (Model Context Protocol) araç koleksiyonu.
Proje dosyalarını tarar, kod yapısının özetini (manifest) çıkarır ve Claude'a sunar —
böylece Claude tüm dosyaları tek tek okumadan önce projeyi anlar.

**Veriler makineden çıkmaz. Harici servis yok. Ücretsiz.**

---

## Amaç

Büyük bir projede Claude'un her dosyayı okuması yavaş ve pahalıdır. ContextMCP projeyi
önceden tarayıp fonksiyon/method imzalarını, tiplerini ve çağrı zincirlerini bir
`mcp-index.json` dosyasına yazar. Claude önce buraya bakar, hangi dosyalara
odaklanacağını bilir. Ayrıca **enterprise-grade code review + APaaS audit suite + rol-bazlı
MCP'ler** sunar — Security/Architecture/Performance/ErrorHandling, endpoint envanteri +
Postman drift, multi-tenant izolasyon, frontend konvansiyon, DevOps/QA/PM/Architect
perspektifleri.

- **Proje izolasyonu** — yalnız belirlenen kök dizin (`CTX_ROOT`) taranır, dışına çıkılmaz
- **Gizli bilgi maskeleme** — API key, token, şifre, bağlantı dizgisi otomatik gizlenir
- **Çok dilli** — TypeScript/JavaScript ve C#/.NET
- **Monorepo** — frontend ve backend ayrı ayrı, karışmadan
- **Code review + Audit Suite** — `review` + 8 audit aracı: TS Compiler API + Roslyn semantic model ile statik kural motoru
- **Opsiyonel LLM enrichment** — API anahtarı verilirse her bulguya daha derin insight, kapalıyken 0 HTTP çağrısı

---

## Bileşenler

| Bileşen | Teknoloji | Rol |
|---------|-----------|-----|
| [ContextMcp/](ContextMcp/) | Node.js / TypeScript | MCP sunucusu — Claude buna bağlanır; 18 araç sunar (navigasyon + review + audit suite + role-MCPs) |
| [ContextMcp.Roslyn/](ContextMcp.Roslyn/) | .NET 9 / Roslyn | C# analiz + review + audit bileşeni — 6 subkomut: `manifest` / `review` / `api-contract` / `tenant-isolation` / `arch-graph` / `domain-events` |

Yalnız **ContextMcp** bir MCP sunucusudur. **ContextMcp.Roslyn** protokol konuşmaz;
ContextMcp'nin C# kodu analiz/review/audit etmek için çağırdığı bir yardımcıdır.

---

## Mimari

```
Claude Code
    │  MCP protokolü (stdio JSON-RPC) — 18 araç
    ▼
ContextMcp                    (Node.js / TypeScript — MCP sunucusu)
    │
    ├─ Navigasyon (6):  build_context / smart_context / final_context /
    │                   find_functions / find_bugs / read_manifest
    │
    ├─ Code Review:     review   (Senior Code Reviewer rolü)
    │
    ├─ APaaS Audit (4): api_contract_audit   (endpoint envanteri + Postman drift)
    │                   frontend_compliance  (axios/DX/interceptor)
    │                   tenant_isolation_audit (multi-tenant EF Core)
    │                   domain_events_map    (publisher/consumer grafı)
    │
    └─ Role-Based (7):  arch_audit       (Architect — layer/cyclic/god-project)
                        qa_audit         (QA — test coverage gaps)
                        devops_audit     (DevOps — Dockerfile/compose/CI/.env)
                        security_audit   (Security — CVE/headers/cookies/auth config)
                        docs_audit       (Tech Writer — README/CLAUDE.md/ADR/link rot)
                        a11y_audit       (a11y Engineer — WCAG: alt/ARIA/label/keyboard)
                        pm_status        (PM — git aktivite + TODO envanteri)

Backend: ContextMcp.Roslyn (.NET 9) subprocess — 6 subkomut
    manifest / review / api-contract / tenant-isolation / arch-graph / domain-events

Opsiyonel: LLM enrichment (LLM_ENABLED=true + API key)
    → Her finding'in `enrichment.insight` alanı LLM ile zenginleştirilir
    → Varsayılan kapalı — 0 HTTP, 0 ek paket
```

---

## Kurulum

```bash
cd ContextMcp && npm install      # MCP sunucusu bağımlılıkları
```

C# desteği için .NET 9 SDK yeterli — `ContextMcp.Roslyn` ilk `dotnet run`'da otomatik derlenir.

Ayrıntılar:
- MCP sunucusu, `.env`, Claude Code entegrasyonu → [ContextMcp/README.md](ContextMcp/README.md)
- C# analiz aracı → [ContextMcp.Roslyn/README.md](ContextMcp.Roslyn/README.md)

---

## Yapılandırma — .env

Taranacak proje `MCPTools/.env` (veya `%APPDATA%\MCPTools\.env`) içinde belirtilir:

```env
CTX_ROOT=C:\Projects\MyApp
```

Birden fazla MCP aynı `.env`'i paylaşabilir.

---

## Çıktı — docs/monorepo/

`build_context` çalışınca, taranan projenin içine yazılır:

```
<proje>/docs/monorepo/
  backend/mcp-index.json     (auto — C# manifest)
  frontend/mcp-index.json    (auto — TS manifest)
  .gitignore                 (auto — mcp-index.json'ları git dışı tutar)
```

Monorepo'da her alt proje (backend, frontend …) kendi manifest'ini alır — karışmaz.
`read_manifest` aracı her sonucu `project` etiketiyle döner, alt projeye filtrelenebilir.

---

## Güvenlik

- Tarama `CTX_ROOT` dışına çıkamaz; sembolik link ile kaçış engellenir
- Yalnız `.ts` `.tsx` `.js` `.jsx` `.cs` dosyaları okunur
- API key, token, şifre, DB bağlantı dizgisi, PEM anahtarı, JWT otomatik maskelenir
- `review` aracı **statik analiz** yapar — hiçbir kod çalıştırılmaz, ağa bağlanılmaz

---

## Kullanım Akışı (Claude Code ile)

```text
Claude → build_context           (ilk oturumda bir kez)
       → smart_context "ödeme"   (kavramla ilgili dosyaları bulur)
       → review "ödeme"     (aynı kapsamı code review'dan geçirir)
       → api_contract_audit      (endpoint envanteri + Postman drift)
       → frontend_compliance "login"  (axios/DX/interceptor kontrolü)
       → tenant_isolation_audit  (EF Core HasQueryFilter eksikleri)
       → arch_audit              (katman ihlali, cyclic refs)
       → qa_audit                (test coverage gaps)
       → devops_audit            (Dockerfile/compose/CI)
       → pm_status               (commit aktivitesi, TODO, dead branches)
       → domain_events_map       (publisher/consumer grafı, orphan event)
```

### Opsiyonel: LLM Enrichment

`.env`'e ekle (varsayılan: kapalı):

```env
LLM_ENABLED=true
LLM_PROVIDER=anthropic
LLM_MODEL=claude-haiku-4-5-20251001
LLM_API_KEY=sk-ant-...
LLM_MAX_TOKENS=1024
LLM_BUDGET_USD_PER_RUN=0.50
```

ve paketi yükle:
```bash
cd ContextMcp && npm install --save-optional @anthropic-ai/sdk
```

Her finding'e `enrichment.insight` (LLM yorumu) eklenir. Hardcoded-secret bulgusu için snippet redact'lanır — sırrın kendisi LLM'e gönderilmez.

Detaylar:
- [ContextMcp/README.md](ContextMcp/README.md#audit-araçları--apaas--role-based-mcps) — tüm araçlar + LLM
- [ContextMcp.Roslyn/README.md](ContextMcp.Roslyn/README.md) — Roslyn subkomutları

---

## Lisans

MIT — bkz. [LICENSE](LICENSE)
