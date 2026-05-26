using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace ContextMcp.Roslyn.Review.Rules;

internal sealed class EmptyCatchRule : IRule
{
    public string Name => "empty-catch";
    public string Category => "ErrorHandling";

    public IEnumerable<Finding> Check(SyntaxTree tree, SemanticModel model, string filePath)
    {
        var root = tree.GetRoot();
        foreach (var catchClause in root.DescendantNodes().OfType<CatchClauseSyntax>())
        {
            if (catchClause.Block.Statements.Count == 0)
            {
                yield return new Finding(
                    "High", "ErrorHandling", filePath, RuleHelpers.LineOf(catchClause),
                    Name,
                    "Boş catch bloğu — hata sessizce yutuluyor.",
                    "Sessiz hatalar production'da en zor ayıklanan sınıftır: işlem yarıda kesilir " +
                    "ama log/alert üretilmez, veri tutarsızlığı oluşur ve gizli regresyon riski doğar.",
                    "En az bir structured log (Microsoft.Extensions.Logging veya Serilog) ekle ve " +
                    "(gerekiyorsa) rethrow et. Boş catch yalnız bilinçli 'best-effort' senaryolarda " +
                    "yorumla gerekçelendirilmeli.");
            }
        }
    }
}

internal sealed class CatchSystemExceptionRule : IRule
{
    public string Name => "catch-system-exception";
    public string Category => "ErrorHandling";

    public IEnumerable<Finding> Check(SyntaxTree tree, SemanticModel model, string filePath)
    {
        var root = tree.GetRoot();
        foreach (var catchClause in root.DescendantNodes().OfType<CatchClauseSyntax>())
        {
            // catch yan tümcesi yoksa veya tip belirtilmemişse: catch { } → genel
            var decl = catchClause.Declaration;
            if (decl is null)
            {
                yield return new Finding(
                    "Medium", "ErrorHandling", filePath, RuleHelpers.LineOf(catchClause),
                    Name,
                    "Tip belirtilmeyen catch { } — tüm exception'lar yakalanıyor.",
                    "Tüm exception'ları yakalamak OutOfMemoryException, StackOverflowException gibi " +
                    "kurtarılamaz hataları gizler ve programı tutarsız durumda bırakabilir.",
                    "Domain-spesifik exception tipleri yakala (örn: HttpRequestException, DbException). " +
                    "Gerçekten generic gerekiyorsa Exception ex yakala, bağlam logla ve rethrow et.");
                continue;
            }

            var typeName = decl.Type?.ToString() ?? "";
            if (typeName == "Exception" || typeName == "System.Exception")
            {
                // Sadece logla + rethrow yapan zararsız pattern'i ayırt etmeye çalışmıyoruz — Medium kalsın.
                yield return new Finding(
                    "Medium", "ErrorHandling", filePath, RuleHelpers.LineOf(catchClause),
                    Name,
                    "Generic Exception yakalanıyor.",
                    "Exception kök tipini yakalamak hataların ayırt edilmesini engeller; " +
                    "kurtarılabilir vs. kurtarılamaz hatalar aynı yola düşer.",
                    "Beklediğin spesifik tipleri yakala. Generic catch yalnız top-level barrier'da " +
                    "(middleware, BackgroundService) kabul edilebilir.");
            }
        }
    }
}

internal sealed class AsyncWithoutCancellationTokenRule : IRule
{
    public string Name => "async-without-cancellation";
    public string Category => "ErrorHandling";

    public IEnumerable<Finding> Check(SyntaxTree tree, SemanticModel model, string filePath)
    {
        var root = tree.GetRoot();
        foreach (var method in root.DescendantNodes().OfType<MethodDeclarationSyntax>())
        {
            bool isAsync = method.Modifiers.Any(m => m.Text == "async");
            bool returnsTask =
                method.ReturnType.ToString() is "Task" or "ValueTask" ||
                method.ReturnType.ToString().StartsWith("Task<") ||
                method.ReturnType.ToString().StartsWith("ValueTask<");
            if (!isAsync && !returnsTask) continue;

            bool isPublic = method.Modifiers.Any(m => m.Text == "public");
            if (!isPublic) continue;

            bool hasCt = method.ParameterList.Parameters.Any(p =>
                p.Type?.ToString() == "CancellationToken" ||
                p.Type?.ToString().EndsWith(".CancellationToken") == true);
            if (hasCt) continue;

            yield return new Finding(
                "Medium", "ErrorHandling", filePath, RuleHelpers.LineOf(method),
                Name,
                $"Public async metod '{method.Identifier.Text}' CancellationToken almıyor.",
                "İptal edilebilir olmayan async metodlar uzun süren işleri kullanıcı vazgeçtiğinde " +
                "veya host shutdown'da kibarca durduramaz; thread pool ve DB connection sızıntısı yapar.",
                "Son parametre olarak CancellationToken ct = default ekle ve aşağıya iletir " +
                "(HttpClient, DbContext, Stream API'lerinin tümü destekler).");
        }
    }
}

internal sealed class MissingDisposeRule : IRule
{
    public string Name => "missing-dispose";
    public string Category => "ErrorHandling";

    private static readonly HashSet<string> DisposableTypes = new()
    {
        "FileStream", "StreamReader", "StreamWriter", "HttpClient", "SqlConnection",
        "SqlCommand", "MemoryStream", "BinaryReader", "BinaryWriter", "HttpRequestMessage",
        "HttpResponseMessage", "FileSystemWatcher", "Timer",
    };

    public IEnumerable<Finding> Check(SyntaxTree tree, SemanticModel model, string filePath)
    {
        var root = tree.GetRoot();
        foreach (var obj in root.DescendantNodes().OfType<ObjectCreationExpressionSyntax>())
        {
            var typeName = obj.Type.ToString();
            if (!DisposableTypes.Contains(typeName)) continue;

            bool inUsing = IsInsideUsing(obj);
            if (inUsing) continue;

            // Field initialization olabilir — class IDisposable implement ediyorsa atla
            var enclosingClass = obj.Ancestors().OfType<ClassDeclarationSyntax>().FirstOrDefault();
            if (obj.Ancestors().OfType<FieldDeclarationSyntax>().Any() && enclosingClass is not null)
            {
                var baseTypes = enclosingClass.BaseList?.Types.Select(t => t.Type.ToString()).ToList()
                                ?? new List<string>();
                if (baseTypes.Contains("IDisposable") || baseTypes.Contains("IAsyncDisposable"))
                    continue;
            }

            yield return new Finding(
                "High", "ErrorHandling", filePath, RuleHelpers.LineOf(obj),
                Name,
                $"IDisposable tip 'new {typeName}()' using olmadan oluşturuluyor.",
                "Dispose edilmeyen kaynaklar bellek/handle sızıntısı ve connection pool tükenmesi " +
                "yapar; production'da kademeli performans düşüşü ve outage'a yol açabilir.",
                "using var x = new ... veya using (var x = new ...) bloğu kullan. " +
                "Field ise sınıfı IDisposable/IAsyncDisposable yap ve Dispose'da temizle.");
        }
    }

    private static bool IsInsideUsing(SyntaxNode node)
    {
        for (var p = node.Parent; p is not null; p = p.Parent)
        {
            if (p is UsingStatementSyntax) return true;
            if (p is LocalDeclarationStatementSyntax local && local.UsingKeyword.Text == "using")
                return true;
        }
        return false;
    }
}

internal static class ErrorHandlingRules
{
    public static readonly IRule[] All = new IRule[]
    {
        new EmptyCatchRule(),
        new CatchSystemExceptionRule(),
        new AsyncWithoutCancellationTokenRule(),
        new MissingDisposeRule(),
    };
}
