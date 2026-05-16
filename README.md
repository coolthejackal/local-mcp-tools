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
odaklanacağını bilir.

- **Proje izolasyonu** — yalnız belirlenen kök dizin (`CTX_ROOT`) taranır, dışına çıkılmaz
- **Gizli bilgi maskeleme** — API key, token, şifre, bağlantı dizgisi otomatik gizlenir
- **Çok dilli** — TypeScript/JavaScript ve C#/.NET
- **Monorepo** — frontend ve backend ayrı ayrı, karışmadan

---

## Bileşenler

| Bileşen | Teknoloji | Rol |
|---------|-----------|-----|
| [ContextMcp/](ContextMcp/) | Node.js / TypeScript | MCP sunucusu — Claude buna bağlanır; TS/JS analizini kendi yapar |
| [ContextMcp.Roslyn/](ContextMcp.Roslyn/) | .NET 9 / Roslyn | C# analiz bileşeni — ContextMcp tarafından çağrılır |

Yalnız **ContextMcp** bir MCP sunucusudur. **ContextMcp.Roslyn** protokol konuşmaz;
ContextMcp'nin C# kodu analiz etmek için çağırdığı bir yardımcıdır.

---

## Mimari

```
Claude Code
    │  MCP protokolü (stdio JSON-RPC)
    ▼
ContextMcp                    (Node.js / TypeScript — MCP sunucusu)
    │
    ├─ TypeScript / JS  →  TS Compiler API   (dahili)
    └─ C#               →  ContextMcp.Roslyn (subprocess, .NET 9)
                                 │
    ┌────────────────────────────┘
    ▼
<proje>/docs/monorepo/<alt-proje>/mcp-index.json
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

---

## Lisans

MIT — bkz. [LICENSE](LICENSE)
