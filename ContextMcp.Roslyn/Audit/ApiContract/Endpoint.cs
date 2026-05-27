namespace ContextMcp.Roslyn.Audit.ApiContract;

// API endpoint envanteri için ortak model. JSON şeması TypeScript tarafı ile uyumlu — camelCase.

internal sealed record Endpoint(
    string Method,              // "GET" | "POST" | "PUT" | "DELETE" | "PATCH"
    string Route,                // birleşik route (MapGroup prefix dahil)
    string Source,               // "minimal-api" | "mvc-controller" | "extension-method"
    string File,
    int Line,
    string? Auth,                // policy/role/role-list  |  null = .RequireAuthorization() (parametresiz) |  "anonymous" = .AllowAnonymous()
    string? HandlerName,         // delegate adı, lambda ise null
    string? RequestType,         // [FromBody] parametre tipi
    string? ResponseType,        // Task<T> generic'in T'si
    bool HasCancellationToken);
