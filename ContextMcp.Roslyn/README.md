# ContextMcp.Roslyn

[`ContextMcp`](../ContextMcp/) MCP sunucusunun **C# analiz bileşeni**. Roslyn
(`Microsoft.CodeAnalysis`) ile C# kaynak kodunu parse eder, kod yapısının özetini
`mcp-index.json` olarak üretir.

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

```bash
dotnet run --project ContextMcp.Roslyn -- <kaynakKök> <çıktıDosyası>
```

Örnek:

```bash
dotnet run --project ContextMcp.Roslyn -- ^
  C:\Projects\MyApp\backend ^
  C:\Projects\MyApp\docs\monorepo\backend\mcp-index.json
```

Normalde elle çalıştırmazsınız — `ContextMcp` `build_context` sırasında otomatik çağırır
([dotnetManifest.ts](../ContextMcp/src/core/dotnetManifest.ts)).

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
| `Program.cs` | Giriş noktası — dosyaları gezer, JSON çıktıyı yazar |
| `Extractor.cs` | Roslyn ile tip / method / attribute / DI çıkarımı |
| `Models.cs` | JSON çıktı modelleri (`ManifestRoot`, `FileEntry`, `FuncEntry`) |

---

## Kısıt

Şu an **MVC controller** odaklıdır. Minimal API endpoint'leri (`app.MapGet(...)`)
yapısal olarak yakalanmaz — bu method'lar normal fonksiyon olarak görünür.
