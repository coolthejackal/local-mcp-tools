# ContextMcp.Roslyn

[`ContextMcp`](../ContextMcp/) MCP sunucusunun **C# analiz bileşeni**. Roslyn
(`Microsoft.CodeAnalysis`) ile C# kaynak kodunu parse eder, iki rolü vardır:

1. **`manifest` subkomutu** — `*.cs` dosyalarından `mcp-index.json` üretir (syntax tree).
2. **`review` subkomutu** — Verilen `*.cs` dosyalarını enterprise code review'dan geçirir
   (`CSharpCompilation` + `SemanticModel`) ve severity seviyelendirilmiş bulgular döner.

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
| `Program.cs` | Giriş noktası — `manifest` / `review` subkomut yönlendirmesi |
| `Extractor.cs` | Manifest için Roslyn tip / method / attribute / DI çıkarımı |
| `Models.cs` | Manifest JSON modelleri (`ManifestRoot`, `FileEntry`, `FuncEntry`) |
| `Review/Finding.cs` | Review bulgu modeli (TS tarafıyla uyumlu) |
| `Review/IRule.cs` | Kural arayüzü ve yardımcılar |
| `Review/ReviewRunner.cs` | `CSharpCompilation` kurar, kuralları çalıştırır, `Finding[]` üretir |
| `Review/Rules/*.cs` | 4 kategori × kural sınıfları |

---

## Kısıt

Şu an **MVC controller** odaklıdır. Minimal API endpoint'leri (`app.MapGet(...)`)
yapısal olarak yakalanmaz — bu method'lar normal fonksiyon olarak görünür.
