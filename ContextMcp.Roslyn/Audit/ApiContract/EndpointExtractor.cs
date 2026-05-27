using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace ContextMcp.Roslyn.Audit.ApiContract;

internal static class EndpointExtractor
{
    private static readonly HashSet<string> MinimalApiMethods = new(StringComparer.Ordinal)
    {
        "MapGet", "MapPost", "MapPut", "MapDelete", "MapPatch",
    };

    private static readonly HashSet<string> McvHttpAttrs = new(StringComparer.Ordinal)
    {
        "HttpGet", "HttpPost", "HttpPut", "HttpDelete", "HttpPatch",
    };

    public static IEnumerable<Endpoint> Extract(SyntaxTree tree, SemanticModel model, string filePath)
    {
        var root = tree.GetRoot();
        foreach (var ep in ExtractMinimalApi(root, model, filePath)) yield return ep;
        foreach (var ep in ExtractMvc(root, filePath)) yield return ep;
    }

    // ── Minimal API ──────────────────────────────────────────────────────────
    private static IEnumerable<Endpoint> ExtractMinimalApi(SyntaxNode root, SemanticModel model, string filePath)
    {
        // MapGroup yerel değişken zincirini metod scope'unda topla.
        // Her metod / lokal fonksiyon kendi grup haritasını üretsin.
        foreach (var method in root.DescendantNodes().Where(n =>
            n is MethodDeclarationSyntax || n is LocalFunctionStatementSyntax))
        {
            var groupRoutes = BuildGroupRouteMap(method);

            foreach (var invocation in method.DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (invocation.Expression is not MemberAccessExpressionSyntax mae) continue;
                if (!MinimalApiMethods.Contains(mae.Name.Identifier.Text)) continue;
                if (invocation.ArgumentList.Arguments.Count < 1) continue;

                var verb = MapNameToVerb(mae.Name.Identifier.Text);
                var routeArg = invocation.ArgumentList.Arguments[0].Expression;
                var routeLiteral = TryReadStringLiteral(routeArg);
                if (routeLiteral is null) continue;

                // Receiver (app, group g, etc.) → varsa prefix
                var prefix = ResolvePrefix(mae.Expression, groupRoutes);
                var fullRoute = JoinRoute(prefix, routeLiteral);

                // Handler delegate / lambda
                var handlerExpr = invocation.ArgumentList.Arguments.Count >= 2
                    ? invocation.ArgumentList.Arguments[1].Expression
                    : null;
                var handlerName = TryReadHandlerName(handlerExpr);

                // Zincirleme: .RequireAuthorization(...) / .AllowAnonymous() / .Produces<T>()
                var (auth, responseType) = WalkFluentChain(invocation);

                // Handler imzasını semantic model üzerinden çöz: request/response tipleri, CT
                var (requestType, taskResponse, hasCt) = ResolveHandlerSignature(handlerExpr, model);
                var resolvedResponse = responseType ?? taskResponse;

                yield return new Endpoint(
                    Method: verb,
                    Route: fullRoute,
                    Source: IsInsideExtensionMethod(method) ? "extension-method" : "minimal-api",
                    File: filePath,
                    Line: invocation.GetLocation().GetLineSpan().StartLinePosition.Line + 1,
                    Auth: auth,
                    HandlerName: handlerName,
                    RequestType: requestType,
                    ResponseType: resolvedResponse,
                    HasCancellationToken: hasCt);
            }
        }
    }

    // Metod scope'unda: var g = app.MapGroup("/api/v1"); var u = g.MapGroup("/users"); ...
    private static Dictionary<string, string> BuildGroupRouteMap(SyntaxNode method)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var decl in method.DescendantNodes().OfType<VariableDeclaratorSyntax>())
        {
            if (decl.Initializer?.Value is not InvocationExpressionSyntax inv) continue;
            if (inv.Expression is not MemberAccessExpressionSyntax mae) continue;
            if (mae.Name.Identifier.Text != "MapGroup") continue;
            if (inv.ArgumentList.Arguments.Count < 1) continue;

            var subRoute = TryReadStringLiteral(inv.ArgumentList.Arguments[0].Expression);
            if (subRoute is null) continue;

            // Zincirleme MapGroup: receiver başka bir grup değişkeniyse, prefix olarak resolve et.
            var prefix = ResolvePrefix(mae.Expression, map);
            map[decl.Identifier.Text] = JoinRoute(prefix, subRoute);
        }
        return map;
    }

    private static string? ResolvePrefix(ExpressionSyntax receiver, Dictionary<string, string> groupRoutes)
    {
        if (receiver is IdentifierNameSyntax id && groupRoutes.TryGetValue(id.Identifier.Text, out var route))
            return route;
        // app, builder, vs. — prefix yok
        return null;
    }

    private static string JoinRoute(string? prefix, string route)
    {
        if (string.IsNullOrEmpty(prefix)) return route;
        var left = prefix!.TrimEnd('/');
        var right = route.StartsWith('/') ? route : "/" + route;
        return left + right;
    }

    private static string? TryReadStringLiteral(ExpressionSyntax expr) => expr switch
    {
        LiteralExpressionSyntax l when l.IsKind(SyntaxKind.StringLiteralExpression) => l.Token.ValueText,
        InterpolatedStringExpressionSyntax i => i.ToString().Trim('"', '$'),  // best-effort
        _ => null,
    };

    private static string MapNameToVerb(string name) => name switch
    {
        "MapGet" => "GET",
        "MapPost" => "POST",
        "MapPut" => "PUT",
        "MapDelete" => "DELETE",
        "MapPatch" => "PATCH",
        _ => "ANY",
    };

    private static string? TryReadHandlerName(ExpressionSyntax? expr) => expr switch
    {
        null => null,
        IdentifierNameSyntax id => id.Identifier.Text,
        MemberAccessExpressionSyntax mae => mae.Name.Identifier.Text,
        _ => null,  // lambda
    };

    // Zincir: .RequireAuthorization(arg?) / .AllowAnonymous() / .Produces<T>()
    private static (string? auth, string? responseType) WalkFluentChain(InvocationExpressionSyntax start)
    {
        string? auth = null;
        string? responseType = null;
        SyntaxNode current = start;

        // start.Parent: . sonrası MemberAccess olabilir → onun parent'ı InvocationExpression
        while (true)
        {
            if (current.Parent is not MemberAccessExpressionSyntax outerMae) break;
            if (outerMae.Parent is not InvocationExpressionSyntax outerInv) break;

            var name = outerMae.Name.Identifier.Text;
            if (name == "RequireAuthorization")
            {
                auth = outerInv.ArgumentList.Arguments.Count == 0
                    ? "(default)"
                    : string.Join(",", outerInv.ArgumentList.Arguments.Select(a => a.ToString()));
            }
            else if (name == "AllowAnonymous")
            {
                auth = "anonymous";
            }
            else if (name == "Produces" && outerMae.Name is GenericNameSyntax gn && gn.TypeArgumentList.Arguments.Count > 0)
            {
                responseType = gn.TypeArgumentList.Arguments[0].ToString();
            }
            current = outerInv;
        }

        return (auth, responseType);
    }

    private static (string? requestType, string? responseType, bool hasCt) ResolveHandlerSignature(
        ExpressionSyntax? handler,
        SemanticModel model)
    {
        if (handler is null) return (null, null, false);

        // Lambda
        if (handler is ParenthesizedLambdaExpressionSyntax pl)
        {
            return AnalyzeParameters(pl.ParameterList.Parameters, pl.ReturnType, model);
        }
        if (handler is SimpleLambdaExpressionSyntax sl)
        {
            // Tek parametre — request body olabilir, type belirsiz
            return AnalyzeParameters(SyntaxFactory.SeparatedList(new[] { sl.Parameter }), returnType: null, model);
        }

        // Method group: GetMe gibi — semantic model'den symbol'a ulaş
        var symbolInfo = model.GetSymbolInfo(handler);
        var symbol = symbolInfo.Symbol ?? symbolInfo.CandidateSymbols.FirstOrDefault();
        if (symbol is IMethodSymbol m)
        {
            string? req = null;
            bool ct = false;
            foreach (var p in m.Parameters)
            {
                var typeName = p.Type.ToDisplayString();
                if (typeName == "System.Threading.CancellationToken" || typeName.EndsWith(".CancellationToken"))
                    ct = true;
                else if (HasFromBody(p))
                    req = typeName;
            }
            var resp = ExtractTaskGeneric(m.ReturnType);
            return (req, resp, ct);
        }
        return (null, null, false);
    }

    private static (string? request, string? response, bool hasCt) AnalyzeParameters(
        SeparatedSyntaxList<ParameterSyntax> parameters,
        TypeSyntax? returnType,
        SemanticModel model)
    {
        string? req = null;
        bool ct = false;
        foreach (var p in parameters)
        {
            var typeStr = p.Type?.ToString() ?? "";
            if (typeStr == "CancellationToken" || typeStr.EndsWith(".CancellationToken"))
            {
                ct = true;
                continue;
            }
            var hasFromBody = p.AttributeLists
                .SelectMany(al => al.Attributes)
                .Any(a => a.Name.ToString() == "FromBody");
            if (hasFromBody && p.Type is not null) req = p.Type.ToString();
        }
        string? resp = null;
        if (returnType is GenericNameSyntax g && (g.Identifier.Text == "Task" || g.Identifier.Text == "ValueTask"))
        {
            resp = g.TypeArgumentList.Arguments.FirstOrDefault()?.ToString();
        }
        return (req, resp, ct);
    }

    private static bool HasFromBody(IParameterSymbol p) =>
        p.GetAttributes().Any(a => a.AttributeClass?.Name == "FromBodyAttribute");

    private static string? ExtractTaskGeneric(ITypeSymbol returnType)
    {
        if (returnType is INamedTypeSymbol n && (n.Name == "Task" || n.Name == "ValueTask") && n.TypeArguments.Length == 1)
            return n.TypeArguments[0].ToDisplayString();
        return null;
    }

    private static bool IsInsideExtensionMethod(SyntaxNode method)
    {
        if (method is MethodDeclarationSyntax md)
            return md.Modifiers.Any(m => m.Text == "static") && md.ParameterList.Parameters.Count > 0
                && md.ParameterList.Parameters[0].Modifiers.Any(m => m.Text == "this");
        return false;
    }

    // ── MVC Controllers ──────────────────────────────────────────────────────
    private static IEnumerable<Endpoint> ExtractMvc(SyntaxNode root, string filePath)
    {
        foreach (var cls in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
        {
            var baseList = cls.BaseList?.Types.Select(t => t.Type.ToString()).ToList() ?? new List<string>();
            bool isController =
                baseList.Contains("ControllerBase") ||
                baseList.Contains("Controller") ||
                cls.Identifier.Text.EndsWith("Controller");
            if (!isController) continue;

            var classRoute = ReadRouteAttribute(cls.AttributeLists);

            foreach (var method in cls.Members.OfType<MethodDeclarationSyntax>())
            {
                if (!method.Modifiers.Any(m => m.Text == "public")) continue;

                foreach (var attr in method.AttributeLists.SelectMany(al => al.Attributes))
                {
                    var name = attr.Name.ToString();
                    if (!McvHttpAttrs.Contains(name)) continue;

                    var verb = name.Substring(4).ToUpperInvariant();  // HttpGet → GET
                    var methodRoute = attr.ArgumentList?.Arguments.FirstOrDefault()
                        is { } first && first.Expression is LiteralExpressionSyntax lit
                            ? lit.Token.ValueText
                            : "";
                    var full = JoinRoute(classRoute, methodRoute);

                    var authAttr = method.AttributeLists.SelectMany(al => al.Attributes)
                        .FirstOrDefault(a => a.Name.ToString() is "Authorize" or "AllowAnonymous");
                    string? auth = authAttr is null
                        ? null
                        : authAttr.Name.ToString() == "AllowAnonymous"
                            ? "anonymous"
                            : authAttr.ArgumentList?.Arguments.ToString() ?? "(default)";

                    bool hasCt = method.ParameterList.Parameters.Any(p =>
                        p.Type?.ToString() == "CancellationToken" ||
                        p.Type?.ToString().EndsWith(".CancellationToken") == true);

                    var requestType = method.ParameterList.Parameters
                        .FirstOrDefault(p => p.AttributeLists
                            .SelectMany(al => al.Attributes)
                            .Any(a => a.Name.ToString() == "FromBody"))
                        ?.Type?.ToString();

                    string? responseType = null;
                    if (method.ReturnType is GenericNameSyntax gn &&
                        (gn.Identifier.Text == "Task" || gn.Identifier.Text == "ValueTask") &&
                        gn.TypeArgumentList.Arguments.Count == 1)
                    {
                        responseType = gn.TypeArgumentList.Arguments[0].ToString();
                    }

                    yield return new Endpoint(
                        Method: verb,
                        Route: full,
                        Source: "mvc-controller",
                        File: filePath,
                        Line: attr.GetLocation().GetLineSpan().StartLinePosition.Line + 1,
                        Auth: auth,
                        HandlerName: method.Identifier.Text,
                        RequestType: requestType,
                        ResponseType: responseType,
                        HasCancellationToken: hasCt);
                }
            }
        }
    }

    private static string? ReadRouteAttribute(SyntaxList<AttributeListSyntax> lists)
    {
        var routeAttr = lists.SelectMany(al => al.Attributes)
            .FirstOrDefault(a => a.Name.ToString() is "Route" or "RoutePrefix");
        if (routeAttr is null) return null;
        var arg = routeAttr.ArgumentList?.Arguments.FirstOrDefault();
        if (arg?.Expression is LiteralExpressionSyntax lit) return lit.Token.ValueText;
        return null;
    }
}
