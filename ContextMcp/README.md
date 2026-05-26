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
