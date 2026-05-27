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
import { reviewCode } from "./review/reviewEngine"
import type { Category, Severity } from "./review/severity"
import { runApiContractAudit } from "./audit/apaas/apiContractAudit/runner"
import { runFrontendCompliance } from "./audit/apaas/frontendCompliance/runner"
import { runTenantIsolationAudit } from "./audit/apaas/tenantIsolation/runner"
import { runArchAudit } from "./audit/roles/archAudit/runner"
import { runQaAudit } from "./audit/roles/qaAudit/runner"
import { runDevOpsAudit } from "./audit/roles/devopsAudit/runner"
import { runSecurityAudit } from "./audit/roles/securityAudit/runner"
import { runDocsAudit } from "./audit/roles/docsAudit/runner"
import { runPmStatus } from "./audit/roles/pmStatus/runner"
import { runDomainEventsMap } from "./audit/apaas/domainEventsMap/runner"
import { searchManifest, loadAnnotations, isManifestStale, listProjects } from "./core/manifestReader"
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
        "Proje dosyalarını tarar, indeksler ve manifest üretir. " +
        `Kök dizin: ${CONFIG.ROOT_DIR}. ` +
        "Monorepo'da alt projeleri (TypeScript / .NET) keşfeder, her birine " +
        "docs/monorepo/<alt-proje>/mcp-index.json üretir. " +
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
    {
      name: "review",
      description:
        "Kod kalitesi review'ı — query ile bulunan kaynak dosyaları enterprise-grade " +
        "code review'dan geçirir. " +
        "Security, Architecture, Performance, ErrorHandling kategorilerinde " +
        "severity seviyelendirilmiş (Critical/High/Medium/Low/Suggestion) bulgular üretir. " +
        "TS/JS: Node tarafında TS Compiler API ile semantic analiz. " +
        "C#: ContextMcp.Roslyn subprocess'i CSharpCompilation + SemanticModel ile çalıştırır. " +
        "Önce build_context çağrılmış olmalı.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Review kapsamı (örn: 'ödeme işlemi', 'authentication', 'kullanıcı kaydı')",
          },
          categories: {
            type: "array",
            items: {
              type: "string",
              enum: ["Security", "Architecture", "Performance", "ErrorHandling"],
            },
            description: "Opsiyonel — yalnız bu kategorilerde tara. Varsayılan: hepsi.",
          },
          minSeverity: {
            type: "string",
            enum: ["Critical", "High", "Medium", "Low", "Suggestion"],
            description: "Opsiyonel — bu seviyenin altındaki bulguları gizler. Varsayılan: Low.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "api_contract_audit",
      description:
        "API endpoint envanteri çıkarır (MVC + Minimal API + MapGroup) ve opsiyonel olarak " +
        "Postman collection'ı ile drift kontrolü yapar. Auth kapsamı, missing-cancellation-token, " +
        "endpoint-no-auth, endpoint-missing-in-postman, endpoint-orphan-in-postman, " +
        "endpoint-route-mismatch gibi kurallar uygular. ContextMcp.Roslyn subprocess'i çağırır.",
      inputSchema: {
        type: "object",
        properties: {
          compareWithPostman: {
            type: "boolean",
            description: "Postman koleksiyonu ile drift kontrolü yap (varsayılan: true).",
          },
          postmanPath: {
            type: "string",
            description: "CTX_ROOT içinde Postman dosyası yolu. Belirtilmezse docs/postman/*.postman_collection.json otomatik aranır.",
          },
          minSeverity: {
            type: "string",
            enum: ["Critical", "High", "Medium", "Low", "Suggestion"],
            description: "Bu seviyenin altındaki bulgular gizlenir. Varsayılan: Low.",
          },
        },
      },
    },
    {
      name: "frontend_compliance",
      description:
        "Frontend (Next.js/React/TSX) konvansiyon ihlallerini tarar: " +
        "direct-axios-call (interceptor bypass), native-html-form-element (DX wrapper bypass), " +
        "manual-toast-on-intercepted-status (5xx/401/429 çift bildirim), missing-loading-state. " +
        "İstisna yorumu: // @frontend-compliance-allow: <rule-name> — <gerekçe>. " +
        "Query-driven — smart_context ile ilgili dosyaları bulur.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Review kapsamı (örn: 'login sayfası', 'kullanıcı kaydı')",
          },
          categories: {
            type: "array",
            items: { type: "string", enum: ["interceptor", "dx-wrapper", "error-handling"] },
            description: "Yalnız bu kategorilerde tara. Varsayılan: hepsi.",
          },
          minSeverity: {
            type: "string",
            enum: ["Critical", "High", "Medium", "Low", "Suggestion"],
            description: "Varsayılan: Low.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "tenant_isolation_audit",
      description:
        "Multi-tenant SaaS izolasyon kontrolü. EF Core DbContext'lerini tarar, " +
        "HasQueryFilter tanımı + TenantId referansı eksikliklerini, yorum olmayan " +
        ".IgnoreQueryFilters() çağrılarını bulur. Roslyn semantic analiz.",
      inputSchema: {
        type: "object",
        properties: {
          minSeverity: {
            type: "string",
            enum: ["Critical", "High", "Medium", "Low", "Suggestion"],
            description: "Varsayılan: Low.",
          },
        },
      },
    },
    {
      name: "arch_audit",
      description:
        "Architect perspektifi: .csproj ProjectReference grafından katman ihlali " +
        "(Domain→Infrastructure), cyclic references, god-project tespiti. " +
        "Roslyn arch-graph subkomutu.",
      inputSchema: {
        type: "object",
        properties: {
          minSeverity: {
            type: "string",
            enum: ["Critical", "High", "Medium", "Low", "Suggestion"],
            description: "Varsayılan: Low.",
          },
          godProjectThreshold: {
            type: "number",
            description: "Bir projeye gelen ref sayısı bu eşiği aşarsa 'god-project' uyarısı (varsayılan: 20).",
          },
        },
      },
    },
    {
      name: "qa_audit",
      description:
        "QA Engineer perspektifi: production fn ↔ test eşleştirmesi, empty-test, " +
        "skipped-test, todo-in-test, excessive-mocks kuralları. " +
        "TS/JS jest/vitest test framework keşfi.",
      inputSchema: {
        type: "object",
        properties: {
          minSeverity: {
            type: "string",
            enum: ["Critical", "High", "Medium", "Low", "Suggestion"],
            description: "Varsayılan: Low.",
          },
          excessiveMocksThreshold: {
            type: "number",
            description: "Bir test'te bu sayıdan fazla mock olursa 'excessive-mocks' (varsayılan: 5).",
          },
        },
      },
    },
    {
      name: "security_audit",
      description:
        "Security Engineer perspektifi — kod-AST dışı güvenlik baseline'ı: " +
        "repo-wide config dosyalarında secret scan, npm audit + dotnet list package CVE, " +
        "HTTP security headers (HSTS / HTTPS redirect / CORS misconfiguration), " +
        "cookie attribute'ları (SameSite / Secure / HttpOnly), " +
        "JWT/Identity auth config (lifetime, password policy), " +
        "license compatibility (copyleft vs proprietary). " +
        "`review` aracı kod-AST tarafını kapsar; security_audit release-öncesi strategic raporu için.",
      inputSchema: {
        type: "object",
        properties: {
          minSeverity: {
            type: "string",
            enum: ["Critical", "High", "Medium", "Low", "Suggestion"],
            description: "Varsayılan: Low.",
          },
          skipDependencyScan: {
            type: "boolean",
            description: "true ise npm audit + dotnet list --vulnerable atlanır (CI dışı hızlı çalıştırma için).",
          },
        },
      },
    },
    {
      name: "devops_audit",
      description:
        "DevOps perspektifi: Dockerfile (multi-stage, non-root USER), docker-compose " +
        "(healthcheck, secret leak), .env (gerçek sırlar), .github/workflows (secret " +
        "leak, cache eksikliği, self-hosted runner) kontrolleri.",
      inputSchema: {
        type: "object",
        properties: {
          minSeverity: {
            type: "string",
            enum: ["Critical", "High", "Medium", "Low", "Suggestion"],
            description: "Varsayılan: Low.",
          },
        },
      },
    },
    {
      name: "docs_audit",
      description:
        "Documentation Writer perspektifi — README, CLAUDE.md, docs/ klasörü kalitesi. " +
        "markdown link rot, CLAUDE.md kırık kod/path referansları, README/CLAUDE.md freshness, " +
        "CHANGELOG senkronizasyonu, ADR kalite (status / supersede link / naming drift), " +
        "stale active doc, runbook freshness, modül-bazlı context doc eksikliği, " +
        "public API XML doc eksikliği. ADR ve CLAUDE.md varsa kalite, yoksa skip — " +
        "proje tasarımına müdahale yok.",
      inputSchema: {
        type: "object",
        properties: {
          minSeverity: {
            type: "string",
            enum: ["Critical", "High", "Medium", "Low", "Suggestion"],
            description: "Varsayılan: Low.",
          },
          readmeStaleDays: {
            type: "number",
            description: "README stale eşik (varsayılan 180 gün).",
          },
          claudeMdStaleDays: {
            type: "number",
            description: "CLAUDE.md stale eşik (varsayılan 90 gün — daha sık güncellenmeli).",
          },
          activeDocStaleDays: {
            type: "number",
            description: "docs/active stale eşik (varsayılan 90 gün).",
          },
          runbookStaleDays: {
            type: "number",
            description: "docs/runbooks stale eşik (varsayılan 365 gün).",
          },
        },
      },
    },
    {
      name: "pm_status",
      description:
        "Project Manager raporu: son N gün commit aktivitesi (kim/ne kadar), " +
        "dead branch'ler, WIP commit envanteri, TODO/FIXME haritası (@owner parse). " +
        "Finding üretmez — yapılandırılmış status raporu döner.",
      inputSchema: {
        type: "object",
        properties: {
          sinceDays: { type: "number", description: "Commit aktivitesi penceresi (varsayılan: 30 gün)." },
          deadBranchDays: { type: "number", description: "Bu kadar gün dokunulmamış branch dead sayılır (varsayılan: 30)." },
        },
      },
    },
    {
      name: "domain_events_map",
      description:
        "Domain event publisher/consumer haritası. " +
        "IEventBus.PublishAsync<T>, IEventHandler<T>, INotificationHandler<T>, IConsumer<T> " +
        "pattern'lerini Roslyn semantic model ile keşfeder. orphan-event, unimplemented-consumer, " +
        "high-fanout-event kuralları.",
      inputSchema: {
        type: "object",
        properties: {
          minSeverity: {
            type: "string",
            enum: ["Critical", "High", "Medium", "Low", "Suggestion"],
            description: "Varsayılan: Low.",
          },
        },
      },
    },
    {
      name: "read_manifest",
      description:
        "Manifest dosyalarında (docs/monorepo/<alt-proje>/mcp-index.json) hızlı arama yapar. " +
        "TypeScript ve C# (.NET) projelerini destekler. Fonksiyon/method imzaları, " +
        "parametre tipleri, return tipi, C# attribute'ları ([HttpGet], [Authorize]), " +
        "çağrı zinciri ve mcp-annotations.json'dan 'neden/domain/risk' notlarını döner. " +
        "Her sonuç hangi alt projeden geldiği (project) etiketiyle gelir. " +
        "build_context gerektirmez. Dosya aramadan önce bu araçla imza bilgisi al.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Fonksiyon/sınıf adı, attribute, domain veya anahtar kelime (örn: 'GetOrder', 'Authorize', 'pricing')",
          },
          project: {
            type: "string",
            description: "Opsiyonel — yalnız bu alt projede ara (örn: 'frontend', 'backend')",
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
        const projects = listProjects()
        return {
          content: [{
            type: "text",
            text:
              `İndeksleme tamamlandı.\nKök dizin: ${CONFIG.ROOT_DIR}\n` +
              `Taranan dosya: ${fileCount}\n` +
              `Manifest üretilen alt projeler: ${projects.length ? projects.join(", ") : "(yok)"}`,
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

      case "review": {
        const opts = (args as { categories?: Category[]; minSeverity?: Severity } | undefined) ?? {}
        return {
          content: [{
            type: "text",
            text: JSON.stringify(reviewCode(query(), opts), null, 2),
          }],
        }
      }

      case "api_contract_audit": {
        const opts = (args as {
          compareWithPostman?: boolean
          postmanPath?: string
          minSeverity?: Severity
        } | undefined) ?? {}
        const result = await runApiContractAudit(opts)
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
      }

      case "frontend_compliance": {
        const opts = (args as {
          categories?: string[]
          minSeverity?: Severity
        } | undefined) ?? {}
        const result = await runFrontendCompliance({
          query: query(),
          categories: opts.categories,
          minSeverity: opts.minSeverity,
        })
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
      }

      case "tenant_isolation_audit": {
        const opts = (args as { minSeverity?: Severity } | undefined) ?? {}
        const result = await runTenantIsolationAudit(opts)
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
      }

      case "arch_audit": {
        const opts = (args as {
          minSeverity?: Severity
          godProjectThreshold?: number
        } | undefined) ?? {}
        const result = await runArchAudit(opts)
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
      }

      case "qa_audit": {
        const opts = (args as {
          minSeverity?: Severity
          excessiveMocksThreshold?: number
        } | undefined) ?? {}
        const result = await runQaAudit(opts)
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
      }

      case "security_audit": {
        const opts = (args as { minSeverity?: Severity; skipDependencyScan?: boolean } | undefined) ?? {}
        const result = await runSecurityAudit(opts)
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
      }

      case "devops_audit": {
        const opts = (args as { minSeverity?: Severity } | undefined) ?? {}
        const result = await runDevOpsAudit(opts)
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
      }

      case "docs_audit": {
        const opts = (args as {
          minSeverity?: Severity
          readmeStaleDays?: number
          claudeMdStaleDays?: number
          activeDocStaleDays?: number
          runbookStaleDays?: number
        } | undefined) ?? {}
        const result = await runDocsAudit(opts)
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
      }

      case "pm_status": {
        const opts = (args as { sinceDays?: number; deadBranchDays?: number } | undefined) ?? {}
        const result = runPmStatus(opts)
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
      }

      case "domain_events_map": {
        const opts = (args as { minSeverity?: Severity } | undefined) ?? {}
        const result = await runDomainEventsMap(opts)
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
      }

      case "read_manifest": {
        const proj = (args as { project?: string } | undefined)?.project
        const result = {
          stale: isManifestStale(),
          projects: listProjects(),
          filter: proj ?? null,
          annotations: Object.keys(loadAnnotations()).length > 0 ? "yüklü" : "yok",
          results: searchManifest(query(), proj),
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
      }

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
