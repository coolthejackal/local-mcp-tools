using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace ContextMcp.Roslyn.Audit.ApiContract;

internal static class ApiContractRunner
{
    public static List<Endpoint> Run(string sourceRoot)
    {
        var trees = new List<(SyntaxTree tree, string path)>();
        foreach (var file in Directory.EnumerateFiles(sourceRoot, "*.cs", SearchOption.AllDirectories))
        {
            if (Extractor.IsExcluded(file)) continue;
            string text;
            try { text = File.ReadAllText(file); }
            catch { continue; }
            var tree = CSharpSyntaxTree.ParseText(text, path: file);
            trees.Add((tree, file));
        }

        if (trees.Count == 0) return new List<Endpoint>();

        var refs = LoadTrustedReferences();
        var compilation = CSharpCompilation.Create(
            assemblyName: "ContextMcp.ApiContract",
            syntaxTrees: trees.Select(t => t.tree),
            references: refs,
            options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var endpoints = new List<Endpoint>();
        foreach (var (tree, path) in trees)
        {
            SemanticModel model;
            try { model = compilation.GetSemanticModel(tree); }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[api-contract] semantic model alınamadı ({path}): {ex.Message}");
                continue;
            }
            try { endpoints.AddRange(EndpointExtractor.Extract(tree, model, path)); }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[api-contract] extract hata ({path}): {ex.Message}");
            }
        }
        return endpoints;
    }

    private static IEnumerable<MetadataReference> LoadTrustedReferences()
    {
        var refs = new List<MetadataReference>();
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (tpa is null) return refs;
        foreach (var path in tpa.Split(Path.PathSeparator))
        {
            try { if (File.Exists(path)) refs.Add(MetadataReference.CreateFromFile(path)); }
            catch { }
        }
        return refs;
    }
}
