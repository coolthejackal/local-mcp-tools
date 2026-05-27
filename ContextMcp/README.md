# ContextMCP

TypeScript/JavaScript projeleri için yerel MCP (Model Context Protocol) sunucusu.  
Proje dosyalarını tarayarak Claude'a bağlam sağlar — yalnızca belirlenen proje diziniyle sınırlı çalışır.  
**Veriler dışarıya çıkmaz. Harici servis yok. Ücretsiz.**

---

## Gereksinimler

- Node.js 18+
- npm

---

## Kurulum

```bash
cd ContextMcp
npm install
```

---

## .env Yapılandırması

Sunucu başlamadan önce bir `.env` dosyası **zorunludur**. İki konum sırayla kontrol edilir:

| Öncelik | Konum | Kullanım |
|---------|-------|----------|
| 1 | `MCPTools\.env` | Geliştirme / çoklu MCP paylaşımlı |
| 2 | `%APPDATA%\MCPTools\.env` | Windows güvenli konum (production) |

Her iki konumda da `.env` bulunamazsa sunucu **başlamaz** ve hata verir.

### .env İçeriği

```env
# Taranacak proje kök dizini (zorunlu)
CTX_ROOT=C:\Projects\MyApp
```

**Önemli:** `CTX_ROOT` mutlak yol olarak verilmesi önerilir.  
Göreli yol verilirse `ts-node`'un çalıştırıldığı dizine göre hesaplanır (`ContextMcp\`).  
Örneğin `CTX_ROOT=../../` → `ContextMcp\` klasöründen iki üst = proje kökü.

> `CTX_ROOT` sürücü kökü (`C:\`) veya sistem dizini (`C:\Windows`) olamaz.  
> Belirtilen dizin mevcut değilse sunucu başlamaz.

### Windows Güvenli Konuma Taşıma

`.env` dosyasını yanlışlıkla değiştirilmekten korumak için `%APPDATA%\MCPTools\.env` konumuna taşıyın:

```powershell
New-Item -ItemType Directory -Force "$env:APPDATA\MCPTools"
@"
CTX_ROOT=C:\Projects\MyApp
"@ | Set-Content "$env:APPDATA\MCPTools\.env" -Encoding utf8
```

Tam yol: `C:\Users\<kullanıcı>\AppData\Roaming\MCPTools\.env`

---

## Claude Code Entegrasyonu (MCP)

Bu, Claude'un doğrudan araç olarak kullandığı asıl çalışma modudur.

### 1. `.mcp.json` dosyasını proje köküne koyun

Proje köküne (Claude Code'u açtığınız klasör) `.mcp.json` dosyası oluşturun:

```json
{
  "mcpServers": {
    "context-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "ts-node",
        "src/mcp.ts"
      ],
      "cwd": "C:\\Projects\\MyApp\\MCPTools\\ContextMcp"
    }
  }
}
```

> `cwd` değerini kendi makinenizdeki `ContextMcp` klasörünün tam yoluyla değiştirin.

### 2. Claude Code'u yeniden başlatın

Claude Code `.mcp.json` dosyasını otomatik algılar ve MCP sunucusunu başlatır.

### 3. Kullanım

Claude'a doğal dilde yazın — araçları otomatik seçer:

```
Kalem toplam tutarları yanlış hesaplanıyor.
İlgili fonksiyonları bul, hesaplamayı kontrol et
ve tekrar yaşanmaması için gerekli testleri yaz.
```

Claude sırasıyla şunları yapar:
1. `build_context` → projeyi indeksler
2. `find_functions` → `hesapla`, `toplam`, `tutar` içeren fonksiyonları bulur
3. `smart_context` → ilgili dosyaları çeker
4. Kodu inceler, hatayı tespit eder
5. Testleri yazar

---

## MCP Araçları

| Araç | Açıklama |
|------|----------|
| `build_context` | Proje dosyalarını tarar ve RAM'e indeksler. Oturum başında bir kez çağrılır. |
| `smart_context` | Sorguyla ilgili dosyaları TF-IDF + call graph analizi ile bulur. |
| `final_context` | Token limitine sıkıştırılmış bağlam döner. Büyük projelerde tercih edin. |
| `find_functions` | Sorguyla eşleşen fonksiyonları ve tam içeriklerini döner. |
| `find_bugs` | İlgili kod bölgelerindeki olası hataları ve anti-pattern'leri tespit eder. |
| `review_code` | Enterprise-grade code review — Security / Architecture / Performance / ErrorHandling. Severity seviyelendirilmiş bulgular. |
| `read_manifest` | `mcp-index.json` içinde fonksiyon / sınıf / attribute araması. |
| `api_contract_audit` | Endpoint envanteri (MVC + Minimal API + MapGroup) + Postman drift, auth kapsamı, missing-cancellation-token. |
| `frontend_compliance` | Frontend konvansiyon kontrolü: direct-axios, native HTML form elemanları, 5xx/401/429 manuel toast, missing loading state. |
| `tenant_isolation_audit` | EF Core multi-tenant izolasyon: HasQueryFilter eksiklikleri, gerekçesiz `.IgnoreQueryFilters()` çağrıları. |
| `arch_audit` | Architect: .csproj referans grafından katman ihlali (Domain→Infrastructure), cyclic refs, god-project. |
| `qa_audit` | QA Engineer: prod fn ↔ test eşleştirmesi, empty-test, skipped-test, todo-in-test, excessive-mocks. |
| `devops_audit` | DevOps: Dockerfile (multi-stage, non-root), docker-compose (healthcheck, secret), .env secrets, CI workflow. |
| `pm_status` | Project Manager: son N gün commit aktivitesi, dead branch'ler, WIP commits, TODO/FIXME envanteri (@owner). |
| `domain_events_map` | Event publisher/consumer grafı — orphan-event, unimplemented-consumer, high-fanout-event. |

---

## `review_code` — Enterprise Code Review

Sorguyla ilgili dosyaları "Senior Code Reviewer" perspektifiyle inceler ve **severity seviyelendirilmiş** bulgular döner.

- **TS/JS** dosyaları: Node tarafında TypeScript Compiler API (semantic analiz) ile 20 kural.
- **C#** dosyaları: `ContextMcp.Roslyn` subprocess'i `CSharpCompilation` + `SemanticModel` ile 18 kural.
- .NET SDK yoksa: yalnız TS bulguları döner, C# kısmı atlanır (kısmi başarı).

### Kategoriler

| Kategori | Örnek kurallar |
|----------|----------------|
| `Security` | hardcoded-secret, sql-injection, xss-sink, weak-crypto, unsafe-eval, missing-authorize (C#) |
| `Architecture` | god-class, long-function/method, too-many-params, deep-nesting, public-mutable-state, static-mutable-state (C#) |
| `Performance` | await-in-loop, sync-fs-in-async, string-concat-in-loop, async-void (C#), blocking-wait-in-async (C#), linq-in-loop (C#) |
| `ErrorHandling` | empty-catch, swallowed-catch, promise-no-catch, async-without-try, missing-dispose (C#), async-without-cancellation (C#) |

### Parametreler

| Parametre | Tip | Zorunlu | Açıklama |
|-----------|-----|---------|----------|
| `query` | `string` | evet | Review kapsamı (örn: `"ödeme işlemi"`, `"authentication"`) |
| `categories` | `string[]` | hayır | Yalnız listelenen kategorilerde tara. Varsayılan: hepsi. |
| `minSeverity` | `string` | hayır | Bu seviyenin altındaki bulguları gizle. Varsayılan: `"Low"`. Geçerli: `Critical` / `High` / `Medium` / `Low` / `Suggestion`. |

### Örnek çağrı

```json
{
  "name": "review_code",
  "arguments": {
    "query": "kullanıcı doğrulama",
    "categories": ["Security", "ErrorHandling"],
    "minSeverity": "Medium"
  }
}
```

### Örnek çıktı

```json
{
  "query": "kullanıcı doğrulama",
  "filesReviewed": 8,
  "summary": { "critical": 1, "high": 3, "medium": 5, "low": 0, "suggestion": 0 },
  "byCategory": { "Security": 2, "Architecture": 0, "Performance": 3, "ErrorHandling": 4 },
  "findings": [
    {
      "severity": "Critical",
      "category": "Security",
      "file": "C:/Projects/MyApp/src/auth/login.ts",
      "line": 42,
      "rule": "sql-injection",
      "message": "Template literal SQL anahtar kelimesi içeriyor ve interpolasyon yapıyor.",
      "impact": "Kullanıcı girdisinin SQL'e birleştirilmesi injection açar; yetkisiz veri okuma...",
      "recommendation": "Parametrik sorgu kullan: pg/mysql2 `?`/`$1` placeholder'ları..."
    }
  ]
}
```

Önce `build_context` çağrılmış olmalı. `find_bugs` araç olarak korunur — hızlı/basit pattern tarama için; `review_code` ise yapılandırılmış, kategori bazlı ve impact/recommendation içeren derinlemesine inceleme.

---

## Audit Araçları — APaaS + Role-Based MCPs

`review_code` "Senior Code Reviewer" rolünün ilk örneği. Aynı altyapı ile **8 yeni rol-bazlı araç** eklendi. Hepsi `Finding[]`-benzeri yapılandırılmış çıktı verir (severity / category / impact / recommendation), opsiyonel LLM enrichment'a hazırdır.

### APaaS Araçları

#### `api_contract_audit`

API endpoint envanteri çıkarır ve Postman drift kontrolü yapar. **Minimal API ağırlıklı ASP.NET Core projelerinde** doğrudan kullanılabilir.

**Endpoint çıkarımı (Roslyn semantic model):**
- Minimal API: `app.MapGet/Post/Put/Delete/Patch(route, handler)` zinciri + `MapGroup` prefix tracking
- MVC controllers: `[HttpGet]` / `[Route]` attribute'ları
- Extension method'lar: `public static void MapXxxEndpoints(this IEndpointRouteBuilder app)`
- Her endpoint için: route, method, auth (policy/role/anonymous), request type ([FromBody]), response type (Task<T>), CancellationToken varlığı

**Postman parser:** `docs/postman/*.postman_collection.json` otomatik aranır; `{{var}}` interpolasyonu `*` wildcard'a normalize edilir; segment-bazlı eşleştirme.

**Kurallar:**

| Rule | Severity |
|------|----------|
| `endpoint-no-auth` | High |
| `endpoint-anonymous-no-justification` | Suggestion |
| `endpoint-missing-cancellation-token` | Medium |
| `endpoint-missing-in-postman` | Medium |
| `endpoint-orphan-in-postman` | Low |
| `endpoint-route-mismatch` | High |

#### `frontend_compliance`

Next.js/React/TSX konvansiyon ihlalleri — query-driven (smart_context ile ilgili dosyalar bulunur).

| Rule | Kategori | Severity |
|------|----------|----------|
| `direct-axios-call` | interceptor | High |
| `native-html-form-element` | dx-wrapper | Medium |
| `manual-toast-on-intercepted-status` | error-handling | Medium |
| `missing-loading-state` | dx-wrapper | Low |

**İstisna sözdizimi:** Bilinçli ihlali işaretlemek için dosya başında veya kuralı tetikleyen satırın hemen üstünde:
```
// @frontend-compliance-allow: native-html-form-element — ADR-021 (HTML5 email autofill)
```

#### `tenant_isolation_audit`

Multi-tenant SaaS izolasyon kontrolü (EF Core odaklı). **Roslyn semantic model** ile DbContext'leri ve `HasQueryFilter` zincirlerini çıkarır.

| Rule | Tetik |
|------|-------|
| `entity-tenant-no-filter` | Entity'de TenantId property var, HasQueryFilter yok |
| `entity-filter-no-tenant-mention` | HasQueryFilter tanımı var ama TenantId referansı içermiyor |
| `ignore-query-filters-without-comment` | `.IgnoreQueryFilters()` çağrısının üstünde gerekçe yorumu yok |

#### `domain_events_map`

Microservice'ler arası event publisher/consumer haritası ve drift tespiti.

**Pattern'ler:** `IEventBus.PublishAsync<T>`, `Send<T>`, `IEventHandler<T>`, `INotificationHandler<T>`, `IConsumer<T>`, `IDomainEventHandler<T>`. Her event'i hangi proje publish ediyor, hangileri dinliyor — `domain-events` Roslyn subkomutu cross-file compilation ile çözer.

| Rule | Severity |
|------|----------|
| `orphan-event` (publisher var, consumer yok) | Medium |
| `unimplemented-consumer` (consumer var, publisher yok) | Low |
| `high-fanout-event` (≥3 consumer) | Suggestion |

### Role-Based MCPs

#### `arch_audit` — Architect Persona

`.csproj` ProjectReference grafından katman ihlali tespiti.

- **Katman tespiti:** proje adı / yolu heuristiği (`Domain`, `Application`, `Infrastructure`, `Api`, `Web`, `Tests`)
- **Yasak kenarlar:** Domain → Infrastructure/Api/Web, Application → Api/Web (Onion / Clean Architecture)
- **Kurallar:** `layer-violation` (High), `cyclic-reference` (High), `god-project` (Medium, default eşik 20 incoming ref)

#### `qa_audit` — QA Engineer Persona

TS/JS test framework keşfi + production fn eşleştirme.

| Rule | Severity |
|------|----------|
| `empty-test` (assertion yok) | High |
| `skipped-test` (`.skip` / `xit`) | Medium |
| `excessive-mocks` (>5 mock setup) | Medium |
| `todo-in-test` | Low |
| `prod-without-test` (eşleşen test bulunamadı) | Low |

#### `devops_audit` — DevOps Engineer Persona

Tek geçişte Dockerfile + docker-compose + .env + CI workflow kontrolü.

| Rule | Hedef | Severity |
|------|-------|----------|
| `container-runs-as-root` | Dockerfile | High |
| `no-multi-stage-build` | Dockerfile | Low |
| `secret-in-dockerfile` / `secret-in-compose` / `secret-in-ci-workflow` | * | Critical |
| `service-no-healthcheck` | docker-compose | Medium |
| `env-file-secret` | .env (`.env.example` whitelist) | High |
| `ci-no-dependency-cache` | .github/workflows | Low |
| `ci-self-hosted-runner` | .github/workflows | Medium |

#### `pm_status` — Project Manager Raporu

Finding üretmez — yapılandırılmış status raporu döner:

```json
{
  "branch": "main",
  "commitActivity": { "sinceDays": 30, "totalCommits": 42, "byAuthor": [...] },
  "deadBranches": [{ "name": "feature/old", "daysStale": 91, ... }],
  "workInProgressCommits": [...],
  "todoInventory": { "total": 17, "byOwner": { "@alice": 5 }, "items": [...] }
}
```

---

## LLM Enrichment (Opsiyonel)

`review_code` ve tüm audit araçları, geçerli API anahtarı sağlandığında her finding'i daha derin bir insight ile zenginleştirir.

**Varsayılan:** kapalı. Hiçbir HTTP çağrısı yapılmaz, `@anthropic-ai/sdk` paketi çekilmez bile (optionalDependencies).

**Aktif etmek için** `.env` (veya `%APPDATA%\MCPTools\.env`):

```env
LLM_ENABLED=true
LLM_PROVIDER=anthropic
LLM_MODEL=claude-haiku-4-5-20251001
LLM_API_KEY=sk-ant-...
LLM_MAX_TOKENS=1024
LLM_BUDGET_USD_PER_RUN=0.50
LLM_CACHE_DIR=.cache/mcp-llm
```

ve paketi kur:
```bash
npm install --save-optional @anthropic-ai/sdk
```

Açıkken her `Finding`'e opsiyonel `enrichment` alanı eklenir:

```json
{
  "rule": "sql-injection",
  "message": "...",
  "enrichment": {
    "insight": "Bu sorgu admin panel filtresinden çağrılıyor; tenant_id ile birleşik kullanım IDOR vektörü ekleyebilir.",
    "confidence": "high",
    "tokensUsed": 287
  }
}
```

**Güvenlik:**
- `hardcoded-secret` bulgusu için snippet redact'lanır — sırrın kendisi LLM'e gönderilmez
- Cache dizini `CTX_ROOT` dışına yazılamaz
- Budget aşılırsa kalan finding'ler enrichment olmadan döner (warn log)

---

## HTTP Sunucusu (opsiyonel)

Hata ayıklama veya harici kullanım için REST API de mevcuttur:

```bash
npm run dev   # http://localhost:4000
```

| Endpoint | Body | Açıklama |
|----------|------|----------|
| `POST /context/build` | — | Proje dosyalarını indeksler |
| `POST /context/smart` | `{ "query": "..." }` | İlgili dosyaları döner |
| `POST /context/final` | `{ "query": "..." }` | Sıkıştırılmış bağlam |
| `POST /context/functions` | `{ "query": "..." }` | Eşleşen fonksiyonlar |
| `POST /context/deep` | `{ "entry": "fonksiyon_adı" }` | Veri akışı zinciri |
| `POST /context/debug` | `{ "query": "..." }` | Olası hatalar |
| `POST /context/review` | `{ "query": "...", "categories": [...], "minSeverity": "..." }` | Enterprise code review |

> Audit araçları (`api_contract_audit`, `frontend_compliance` vb.) şimdilik **yalnız MCP stdio** üzerinden çağrılır — HTTP endpoint'leri eklenmedi. UI'dan ihtiyaç olursa eklenir.

---

## İzolasyon ve Güvenlik

- Tarama yalnızca `CTX_ROOT` altında kalır — dışarı çıkamaz.
- Sembolik link ile izolasyon atlatma engellenir.
- `MCPTools` klasörü kendisi tarama dışında tutulur.
- Taranan dosya türleri: `.ts` `.tsx` `.js` `.jsx` `.cs`
- Otomatik maskelenen değerler: API key, password, secret, token, DB URL, PEM anahtarları, JWT.

---

## Proje Yapısı İçindeki Konum

```
MyProject\                  ← Claude Code buradan açılır
  .mcp.json                 ← Claude Code bu dosyayı okur
  MCPTools\
    .env                    ← CTX_ROOT=C:\Projects\MyApp
    ContextMcp\             ← bu sunucu
      src\
        mcp.ts              ← MCP stdio sunucu
        server.ts           ← HTTP sunucu (opsiyonel)
      package.json
```

Birden fazla MCP aynı `MCPTools\.env` dosyasını paylaşabilir.
