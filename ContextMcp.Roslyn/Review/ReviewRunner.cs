using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using ContextMcp.Roslyn.Review.Rules;

namespace ContextMcp.Roslyn.Review;

internal static class ReviewRunner
{
    public static IReadOnlyList<IRule> AllRules { get; } =
        SecurityRules.All
            .Concat(ArchitectureRules.All)
            .Concat(PerformanceRules.All)
            .Concat(ErrorHandlingRules.All)
            .ToArray();

    public static List<Finding> Run(IEnumerable<string> filePaths, IReadOnlyCollection<string>? categories)
    {
        var trees = new List<(SyntaxTree tree, string path)>();
        foreach (var path in filePaths)
        {
            if (!File.Exists(path)) continue;
            if (Extractor.IsExcluded(path)) continue;
            string text;
            try { text = File.ReadAllText(path); }
            catch { continue; }
            var tree = CSharpSyntaxTree.ParseText(text, path: path);
            trees.Add((tree, path));
        }

        if (trees.Count == 0) return new List<Finding>();

        // Tek bir compilation — semantic queries için. Bağımlılık çözümü için
        // standart trustedReferences ekliyoruz; resolution başarısız olsa bile
        // syntax tabanlı kurallar çalışır.
        var refs = LoadTrustedReferences();
        var compilation = CSharpCompilation.Create(
            assemblyName: "ContextMcp.Review",
            syntaxTrees: trees.Select(t => t.tree),
            references: refs,
            options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var activeRules = categories is { Count: > 0 }
            ? AllRules.Where(r => categories.Contains(r.Category)).ToArray()
            : AllRules.ToArray();

        var findings = new List<Finding>();
        foreach (var (tree, path) in trees)
        {
            SemanticModel model;
            try { model = compilation.GetSemanticModel(tree); }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[review] semantic model alınamadı ({path}): {ex.Message}");
                continue;
            }

            foreach (var rule in activeRules)
            {
                try
                {
                    findings.AddRange(rule.Check(tree, model, path));
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[review] kural '{rule.Name}' '{path}' üzerinde hata verdi: {ex.Message}");
                }
            }
        }
        return findings;
    }

    private static IEnumerable<MetadataReference> LoadTrustedReferences()
    {
        // TPA listesi: çalışan runtime'ın yüklediği assembly'ler — ekstra restore yapmadan
        // System.* başvurularını sağlar. Eksik olsa bile syntax tabanlı kurallar bozulmaz.
        var refs = new List<MetadataReference>();
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (tpa is null) return refs;

        foreach (var path in tpa.Split(Path.PathSeparator))
        {
            try
            {
                if (File.Exists(path))
                    refs.Add(MetadataReference.CreateFromFile(path));
            }
            catch
            {
                // ignore individual reference failures
            }
        }
        return refs;
    }
}
