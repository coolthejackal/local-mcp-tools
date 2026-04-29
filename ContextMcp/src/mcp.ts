// MCP SDK ESM paket olduğundan CommonJS projede require() ile yükleniyor.
// moduleResolution:node exports-map'i anlamadığından @ts-ignore kullanılıyor.
/* eslint-disable @typescript-eslint/no-require-imports */
// @ts-ignore
const { Server }               = require("@modelcontextprotocol/sdk/server")        as { Server: new (info: object, opts: object) => McpServer }
// @ts-ignore
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js") as { StdioServerTransport: new () => Transport }
// @ts-ignore
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js") as { CallToolRequestSchema: unknown; ListToolsRequestSchema: unknown }

import { buildContext, getContext } from "./core/indexer"
import { buildSmartContext } from "./context/smartContext"
import { buildFinalContext } from "./optimize/smartContextFinal"
import { buildFunctionContext } from "./function/functionContext"
import { findBug } from "./debug/smartBugFinder"
import { CONFIG } from "./core/config"

// ─── Minimal tip tanımları ────────────────────────────────────────────────────
interface Transport {
  // StdioServerTransport için opak tip
}

interface McpServer {
  setRequestHandler(schema: unknown, handler: (req: unknown) => Promise<unknown>): void
  connect(transport: Transport): Promise<void>
}

interface CallRequest {
  params: {
    name: string
    arguments?: Record<string, unknown>
  }
}

// ─── Server ───────────────────────────────────────────────────────────────────
const server: McpServer = new Server(
  { name: "context-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
)

// ─── Tool listesi ─────────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "build_context",
      description:
        "Proje dosyalarını tarar ve RAM'e indeksler. " +
        `Kök dizin: ${CONFIG.ROOT_DIR}. ` +
        "Oturum başında bir kez, dosyalar değiştikten sonra tekrar çağrılmalı.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "smart_context",
      description:
        "Sorguyla ilgili kaynak dosyaları TF-IDF + call graph analizi ile bulur ve sıralar. " +
        "Önce build_context çağrılmış olmalı.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Arama sorgusu (örn: 'kalem toplam hesaplama', 'kullanıcı doğrulama')",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "final_context",
      description:
        "Token limitine sıkıştırılmış, önceliklendirilmiş kod bağlamı döner. " +
        "Büyük projelerde smart_context yerine bunu kullan.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Arama sorgusu" },
        },
        required: ["query"],
      },
    },
    {
      name: "find_functions",
      description:
        "Sorguyla eşleşen fonksiyonları bulur ve tam içeriklerini döner. " +
        "Belirli bir fonksiyonu incelemek için kullan.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Fonksiyon adı veya anahtar kelime (örn: 'calculateTotal', 'hesapla')",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "find_bugs",
      description:
        "Sorguyla ilgili kod bölgelerinde olası hataları ve anti-pattern'leri tespit eder. " +
        "Bir özellikte hata araştırırken kullan.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Hata bağlamı (örn: 'kalem fiyat hesaplama', 'null kontrolü')",
          },
        },
        required: ["query"],
      },
    },
  ],
}))

// ─── Tool çağrıları ───────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request: unknown) => {
  const { name, arguments: args } = (request as CallRequest).params

  const query = (): string => {
    const q = (args as { query: string } | undefined)?.query
    if (!q) throw new Error("'query' parametresi zorunlu")
    return q
  }

  try {
    switch (name) {
      case "build_context": {
        buildContext()
        const fileCount = Object.keys(getContext()).length
        return {
          content: [{
            type: "text",
            text: `İndeksleme tamamlandı.\nKök dizin: ${CONFIG.ROOT_DIR}\nToplam dosya: ${fileCount}`,
          }],
        }
      }

      case "smart_context":
        return { content: [{ type: "text", text: JSON.stringify(buildSmartContext(query()), null, 2) }] }

      case "final_context":
        return { content: [{ type: "text", text: JSON.stringify(buildFinalContext(query()), null, 2) }] }

      case "find_functions":
        return { content: [{ type: "text", text: JSON.stringify(buildFunctionContext(query()), null, 2) }] }

      case "find_bugs":
        return { content: [{ type: "text", text: JSON.stringify(findBug(query()), null, 2) }] }

      default:
        throw new Error(`Bilinmeyen araç: ${name}`)
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `Hata: ${(err as Error).message}` }],
      isError: true,
    }
  }
})

// ─── Başlat ───────────────────────────────────────────────────────────────────
async function main() {
  const transport: Transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(`[ContextMCP] Başlatıldı. Kök: ${CONFIG.ROOT_DIR}\n`)
}

main().catch((err) => {
  process.stderr.write(`[ContextMCP] Başlatma hatası: ${(err as Error).message}\n`)
  process.exit(1)
})
