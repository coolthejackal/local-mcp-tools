# ContextMcp.Roslyn

[`ContextMcp`](../ContextMcp/) MCP sunucusunun **C# analiz bileşeni**. Roslyn
(`Microsoft.CodeAnalysis`) ile C# kaynak kodunu parse eder. Altı subkomut sunar:

1. **`manifest`** — `*.cs` dosyalarından `mcp-index.json` üretir (syntax tree).
2. **`review`** — Verilen dosyaları enterprise code review'dan geçirir (Security/Architecture/Performance/ErrorHandling, semantic model).
3. **`api-contract`** — Endpoint envanteri: Minimal API + MapGroup + MVC controllers, [Authorize] / `.RequireAuthorization()` parse, request/response tipleri, CancellationToken varlığı.
4. **`tenant-isolation`** — EF Core multi-tenant analizi: DbContext'ler, `HasQueryFilter` zincirleri, `.IgnoreQueryFilters()` çağrıları + yorum durumu.
5. **`arch-graph`** — `.csproj` ProjectReference grafından proje düğümleri ve katman atamaları.
6. **`domain-events`** — Publisher/Consumer pattern keşfi (IEventBus.PublishAsync<T>, IEventHandler<T> vb.) — cross-file compilation.

> **Bu bir MCP sunucusu değildir.** MCP protokolü konuşmaz. `ContextMcp`'nin subprocess
> olarak çağırdığı bir komut satırı aracıdır — normalde elle çalıştırılmaz.

---

## Gereksinim

- .NET 9 SDK

---

## Ne Yapar

`*.cs` dosyalarını gezer (`bin/`, `obj/`, `node_modules/` hariç) ve her dosya için çıkarır:

- **Sınıf / interface / record** — ad, `kind` sınıflandırması
- **Method'lar** — ad, kapsayan sınıf, parametreler (`ad: Tip`), dönüş tipi,
  attribute'lar (`[HttpGet]`, `[Authorize]` …), çağrılan method adları
- **DI bağımlılıkları** — constructor (primary constructor dahil) parametre tipleri
- **exports** — public tipler

Yalnız **syntax tree** kullanır — proje derlenmiş olmak zorunda değil, MSBuild gerekmez.

---

## `kind` Sınıflandırması

| kind | Tespit |
|------|--------|
| `controller` | `ControllerBase` türevi / `[ApiController]` / ad `Controller` ile biter |
| `hub` | `Hub` türevi (SignalR) |
| `dbcontext` | `DbContext` türevi (EF Core) |
| `service` | Ad `Service` ile biter |
| `repository` | Ad `Repository` ile biter |
| `dto` | `record` veya ad `Dto` / `Request` / `Response` ile biter |
| `entity` | `Domain` / `Entities` / `Models` klasöründe düz sınıf |
| `interface` | Interface |
| `other` | Diğer |

---

## Kullanım

### `manifest` subkomutu (varsayılan, geriye uyumlu)

```bash
dotnet run --project ContextMcp.Roslyn -- manifest <kaynakKök> <çıktıDosyası>
```

İlk argüman `manifest` veya `review` değilse eski davranışla `<kaynakKök> <çıktıDosyası>`
olarak yorumlanır — geriye uyumluluk korunur.

Örnek:

```bash
dotnet run --project ContextMcp.Roslyn -- manifest ^
  C:\Projects\MyApp\backend ^
  C:\Projects\MyApp\docs\monorepo\backend\mcp-index.json
```

Normalde elle çalıştırmazsınız — `ContextMcp` `build_context` sırasında otomatik çağırır
([dotnetManifest.ts](../ContextMcp/src/core/dotnetManifest.ts)).

### `review` subkomutu

```bash
dotnet run --project ContextMcp.Roslyn -- review <dosyaListesi> <çıktıDosyası> [--categories=...]
```

| Argüman | Açıklama |
|---------|----------|
| `<dosyaListesi>` | Review edilecek mutlak `.cs` yollarının newline-delimited listesi (TS tarafı geçici dosyada üretir) |
| `<çıktıDosyası>` | `Finding[]` JSON dizisinin yazılacağı yol |
| `--categories=...` | Opsiyonel — virgülle ayrılmış kategori filtresi (`Security,Architecture,Performance,ErrorHandling`) |

Bu komut da normalde elle çalıştırılmaz — `ContextMcp`'nin `review_code` aracı
[roslynBridge.ts](../ContextMcp/src/review/roslynBridge.ts) üzerinden tetikler.

### `api-contract` subkomutu

```bash
dotnet run --project ContextMcp.Roslyn -- api-contract <kaynakKök> <çıktıDosyası>
```

Tüm endpoint envanterini camelCase JSON dizisi olarak yazar. Şekil:

```json
[
  {
    "method": "POST",
    "route": "/api/v1/users/{id}",
    "source": "minimal-api",
    "file": "...",
    "line": 42,
    "auth": "AuthorizationPoliciesSetup.UserOnly",
    "handlerName": "UpdateUser",
    "requestType": "UpdateUserRequest",
    "responseType": "Task<IResult>",
    "hasCancellationToken": true
  }
]
```

`source` değerleri: `minimal-api`, `extension-method`, `mvc-controller`. `auth` `null` (yok), `"anonymous"` (AllowAnonymous), veya `RequireAuthorization` argümanlarının metni.

TS tarafı: [api_contract_audit](../ContextMcp/src/audit/apaas/apiContractAudit/) bu çıktıyı Postman koleksiyonu ile karşılaştırarak drift bulur.

### `tenant-isolation` subkomutu

```bash
dotnet run --project ContextMcp.Roslyn -- tenant-isolation <kaynakKök> <çıktıDosyası>
```

```json
{
  "entities": [
    { "name": "Order", "hasTenantIdProperty": true, "hasQueryFilter": false, ... }
  ],
  "ignoreCalls": [
    { "file": "...", "line": 84, "hasPrecedingComment": false }
  ]
}
```

Tanınan tenant property adları: `TenantId`, `WorkspaceId`, `OrganizationId`, `tenant_id` (case-insensitive). `HasQueryFilter` çağrı argümanı içinde bu adlardan biri geçiyorsa filter "tenant-aware" sayılır.

### `arch-graph` subkomutu

```bash
dotnet run --project ContextMcp.Roslyn -- arch-graph <kaynakKök> <çıktıDosyası>
```

`.csproj` dosyalarını recursive tarayıp ProjectReference grafını XML'den okur. Katman tespiti proje adı + path heuristiğiyle (`\bdomain\b`, `\binfrastructure\b`, `\bapplication\b`, `\bapi\b|\bcontrollers?\b`, `\btests?\b`).

```json
{
  "projects": [
    { "name": "MyApp.Domain", "path": "...", "layer": "domain", "references": ["MyApp.Common"] }
  ]
}
```

### `domain-events` subkomutu

```bash
dotnet run --project ContextMcp.Roslyn -- domain-events <kaynakKök> <çıktıDosyası>
```

Tüm `.cs` dosyalarını **tek bir CSharpCompilation** içinde toplar — cross-file event tipi çözümlemesi için. Publisher pattern'leri: `PublishAsync`, `Publish`, `Send`, `SendAsync`, `Notify`, `Dispatch`, `DispatchAsync` (generic invocation veya semantic-type-info argümandan). Consumer interface'leri: `IEventHandler<T>`, `INotificationHandler<T>`, `IConsumer<T>`, `IRequestHandler<T>`, `IDomainEventHandler<T>`.

```json
{
  "publishers": [{ "eventType": "OrderCreated", "file": "...", "line": 42, "project": "MyApp.Orders.API" }],
  "consumers":  [{ "eventType": "OrderCreated", "handlerClass": "OrderCreatedHandler", "file": "...", "line": 18, "project": "MyApp.Notifications.API" }]
}
```

`project` alanı: dosya yolundan en yakın `.csproj` içeren klasörün adı (heuristik).

---

## Review Kuralları

`CSharpCompilation` + `SemanticModel` kullanılır; sözdizimi düzeyinin ötesinde
tip / sembol bilgisine erişilir (örn. `string += ...` için sol tarafın gerçekten
`System.String` olduğunu semantic model'den teyit ediyoruz).

| Kategori | Kurallar |
|----------|----------|
| `Security` | hardcoded-secret, sql-injection, weak-crypto, missing-authorize |
| `Architecture` | god-class, long-method, too-many-params, public-mutable-field, static-mutable-state |
| `Performance` | async-void, blocking-wait-in-async, list-in-loop-alloc, string-concat-in-loop, linq-in-loop |
| `ErrorHandling` | empty-catch, catch-system-exception, async-without-cancellation, missing-dispose |

### Finding Şeması (`review` çıktısı)

`ContextMcp` TypeScript tarafıyla birebir uyumlu — `camelCase` JSON:

```json
[
  {
    "severity": "Critical",
    "category": "Security",
    "file": "C:/Projects/MyApp/Controllers/OrderController.cs",
    "line": 84,
    "rule": "sql-injection",
    "message": "Interpolated string SQL anahtar kelimesi içeriyor...",
    "impact": "Kullanıcı girdisinin SQL'e birleştirilmesi injection açar...",
    "recommendation": "Parametre kullan: SqlCommand.Parameters.AddWithValue(...)..."
  }
]
```

---

## Çıktı Formatı

`ContextMcp`'nin TypeScript manifest'iyle aynı şema (`mcp-index.json`):

```json
{
  "generated": "2026-05-16T06:19:31.037Z",
  "root": "C:\\Projects\\MyApp\\backend",
  "files": {
    "src/Controllers/OrderController.cs": {
      "kind": "controller",
      "functions": [
        {
          "name": "GetOrder",
          "class": "OrderController",
          "params": ["id: Guid"],
          "returns": "Task<IActionResult>",
          "attributes": ["HttpGet(\"{id}\")", "Authorize"],
          "calls": ["GetByIdAsync", "Ok"]
        }
      ],
      "exports": ["OrderController"],
      "dependencies": ["IOrderService"]
    }
  }
}
```

---

## Kaynak Dosyalar

| Dosya | İçerik |
|-------|--------|
| `Program.cs` | Giriş noktası — 6 subkomut yönlendirmesi (manifest / review / api-contract / tenant-isolation / arch-graph / domain-events) |
| `Extractor.cs` | Manifest için Roslyn tip / method / attribute / DI çıkarımı |
| `Models.cs` | Manifest JSON modelleri (`ManifestRoot`, `FileEntry`, `FuncEntry`) |
| `Review/Finding.cs` + `IRule.cs` + `ReviewRunner.cs` | Code review altyapısı (CSharpCompilation + SemanticModel) |
| `Review/Rules/*.cs` | 4 kategori × kural sınıfları (Security, Architecture, Performance, ErrorHandling) |
| `Audit/ApiContract/*.cs` | `api-contract` subkomutu — Minimal API + MapGroup + MVC endpoint extractor |
| `Audit/TenantIsolation/TenantIsolationRunner.cs` | `tenant-isolation` subkomutu — DbContext + HasQueryFilter zincirleri |
| `Audit/ArchGraph/ArchGraphRunner.cs` | `arch-graph` subkomutu — .csproj ProjectReference + layer tespiti |
| `Audit/DomainEvents/DomainEventsRunner.cs` | `domain-events` subkomutu — publisher/consumer pattern keşfi (cross-file) |

---

## Kısıt

Şu an **MVC controller** odaklıdır. Minimal API endpoint'leri (`app.MapGet(...)`)
yapısal olarak yakalanmaz — bu method'lar normal fonksiyon olarak görünür.
