using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace ContextMcp.Roslyn.Review.Rules;

internal static class FlowHelpers
{
    public static bool IsInsideLoop(SyntaxNode node)
    {
        for (var p = node.Parent; p is not null; p = p.Parent)
        {
            if (p is ForStatementSyntax || p is ForEachStatementSyntax ||
                p is WhileStatementSyntax || p is DoStatementSyntax)
                return true;
            if (p is MethodDeclarationSyntax || p is LocalFunctionStatementSyntax ||
                p is AnonymousFunctionExpressionSyntax)
                return false;
        }
        return false;
    }

    public static MethodDeclarationSyntax? EnclosingMethod(SyntaxNode node)
    {
        for (var p = node.Parent; p is not null; p = p.Parent)
        {
            if (p is MethodDeclarationSyntax m) return m;
        }
        return null;
    }

    public static bool IsAsync(MethodDeclarationSyntax? method) =>
        method?.Modifiers.Any(m => m.Text == "async") ?? false;
}

internal sealed class AsyncVoidRule : IRule
{
    public string Name => "async-void";
    public string Category => "Performance";

    public IEnumerable<Finding> Check(SyntaxTree tree, SemanticModel model, string filePath)
    {
        var root = tree.GetRoot();
        foreach (var method in root.DescendantNodes().OfType<MethodDeclarationSyntax>())
        {
            bool isAsync = method.Modifiers.Any(m => m.Text == "async");
            bool returnsVoid = method.ReturnType is PredefinedTypeSyntax pts &&
                               pts.Keyword.IsKind(SyntaxKind.VoidKeyword);
            if (isAsync && returnsVoid)
            {
                // Event handler istisnası: parametreleri (object, EventArgs) örüntüsüne uyuyorsa atla.
                bool looksLikeEventHandler =
                    method.ParameterList.Parameters.Count == 2 &&
                    method.ParameterList.Parameters[1].Type?.ToString().EndsWith("EventArgs") == true;
                if (looksLikeEventHandler) continue;

                yield return new Finding(
                    "High", "Performance", filePath, RuleHelpers.LineOf(method),
                    Name,
                    $"'async void' metod: {method.Identifier.Text}.",
                    "async void metodlardaki exception'lar await edilemez ve process'i çökertebilir. " +
                    "Çağıran tamamlanmayı bekleyemez, hata propagasyonu kaybolur.",
                    "Dönüş tipini 'async Task' olarak değiştir. " +
                    "Yalnız event handler imzaları için async void kabul edilebilir.");
            }
        }
    }
}

internal sealed class BlockingWaitInAsyncRule : IRule
{
    public string Name => "blocking-wait-in-async";
    public string Category => "Performance";

    public IEnumerable<Finding> Check(SyntaxTree tree, SemanticModel model, string filePath)
    {
        var root = tree.GetRoot();
        foreach (var ma in root.DescendantNodes().OfType<MemberAccessExpressionSyntax>())
        {
            var name = ma.Name.Identifier.Text;
            if (name != "Result" && name != "Wait" && name != "GetAwaiter") continue;

            // Sadece async metod içindeyse anlamlı
            if (!FlowHelpers.IsAsync(FlowHelpers.EnclosingMethod(ma))) continue;

            if (name == "GetAwaiter")
            {
                if (ma.Parent is InvocationExpressionSyntax inv &&
                    inv.Parent is MemberAccessExpressionSyntax ma2 &&
                    ma2.Name.Identifier.Text == "GetResult")
                {
                    yield return Build(ma, filePath, ".GetAwaiter().GetResult()");
                }
            }
            else
            {
                yield return Build(ma, filePath, "." + name);
            }
        }
    }

    private Finding Build(SyntaxNode node, string filePath, string pattern) => new(
        "High", "Performance", filePath, RuleHelpers.LineOf(node),
        Name,
        $"Async metod içinde blocking call: {pattern}.",
        "Task üzerinde .Result/.Wait()/.GetAwaiter().GetResult() thread'i bloklar ve " +
        "ASP.NET Core sync context'inde deadlock riski yaratır. Thread pool starvation'a yol açar.",
        "await kullan: var x = await task; — eğer call site senkron olmak zorundaysa, " +
        "Task.Run ile arka plana al, ama mümkünse imzayı async yap.");
}

internal sealed class ListInLoopAllocationRule : IRule
{
    public string Name => "list-in-loop-alloc";
    public string Category => "Performance";

    public IEnumerable<Finding> Check(SyntaxTree tree, SemanticModel model, string filePath)
    {
        var root = tree.GetRoot();
        foreach (var obj in root.DescendantNodes().OfType<ObjectCreationExpressionSyntax>())
        {
            var typeName = obj.Type.ToString();
            bool isCollection =
                typeName.StartsWith("List<") ||
                typeName.StartsWith("Dictionary<") ||
                typeName.StartsWith("HashSet<") ||
                typeName.StartsWith("StringBuilder");
            if (!isCollection) continue;
            if (!FlowHelpers.IsInsideLoop(obj)) continue;

            yield return new Finding(
                "Medium", "Performance", filePath, RuleHelpers.LineOf(obj),
                Name,
                $"Döngü içinde yeni koleksiyon alokasyonu: new {typeName}().",
                "Her iterasyonda yeni allocation GC baskısı ve büyük N'de p99 latency artışı yaratır.",
                "Koleksiyonu döngü dışında oluştur ve her iterasyonda .Clear() ile yeniden kullan, " +
                "veya ArrayPool / ObjectPool değerlendir.");
        }
    }
}

internal sealed class StringConcatInLoopRule : IRule
{
    public string Name => "string-concat-in-loop";
    public string Category => "Performance";

    public IEnumerable<Finding> Check(SyntaxTree tree, SemanticModel model, string filePath)
    {
        var root = tree.GetRoot();
        foreach (var assign in root.DescendantNodes().OfType<AssignmentExpressionSyntax>())
        {
            if (!assign.IsKind(SyntaxKind.AddAssignmentExpression)) continue;
            if (!FlowHelpers.IsInsideLoop(assign)) continue;

            // Sol taraf string'e benziyor mu? (basit tahmin: ifade adı *str* veya tip string)
            var leftType = model.GetTypeInfo(assign.Left).Type;
            bool isString = leftType?.SpecialType == SpecialType.System_String;
            if (!isString) continue;

            yield return new Finding(
                "Medium", "Performance", filePath, RuleHelpers.LineOf(assign),
                Name,
                "Döngü içinde string += birikimi yapılıyor.",
                ".NET string'leri immutable; her += yeni allocation yapar — büyük N'de O(N²) maliyet.",
                "StringBuilder kullan ve sonunda .ToString() çağır.");
        }
    }
}

internal sealed class LinqInLoopRule : IRule
{
    public string Name => "linq-in-loop";
    public string Category => "Performance";

    private static readonly HashSet<string> TerminalOps = new()
    {
        "ToList", "ToArray", "ToDictionary", "ToHashSet", "Count", "First", "FirstOrDefault",
        "Single", "SingleOrDefault", "Any", "All", "Sum", "Min", "Max", "Average",
    };

    public IEnumerable<Finding> Check(SyntaxTree tree, SemanticModel model, string filePath)
    {
        var root = tree.GetRoot();
        foreach (var inv in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            if (inv.Expression is not MemberAccessExpressionSyntax ma) continue;
            if (!TerminalOps.Contains(ma.Name.Identifier.Text)) continue;
            if (!FlowHelpers.IsInsideLoop(inv)) continue;

            yield return new Finding(
                "Medium", "Performance", filePath, RuleHelpers.LineOf(inv),
                Name,
                $"Döngü içinde LINQ terminal operasyon: .{ma.Name.Identifier.Text}().",
                "Döngü içindeki LINQ terminal çağrıları her iterasyonda koleksiyonu yeniden " +
                "enumerate eder; IQueryable üzerindeyse N+1 DB sorgusu üretebilir.",
                "Koleksiyonu döngü öncesi bir kez materialize et (.ToList()) ve içinde dictionary/lookup " +
                "ile ara, veya tek bir GroupBy/Join sorgusuna dönüştür.");
        }
    }
}

internal static class PerformanceRules
{
    public static readonly IRule[] All = new IRule[]
    {
        new AsyncVoidRule(),
        new BlockingWaitInAsyncRule(),
        new ListInLoopAllocationRule(),
        new StringConcatInLoopRule(),
        new LinqInLoopRule(),
    };
}
