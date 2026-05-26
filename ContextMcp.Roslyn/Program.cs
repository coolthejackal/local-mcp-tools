using System.Text.Json;
using Microsoft.CodeAnalysis.CSharp;
using ContextMcp.Roslyn;
using ContextMcp.Roslyn.Review;

// Argümanlar:
//   ContextMcp.Roslyn manifest <kaynakKök> <çıktıDosyası>
//   ContextMcp.Roslyn review <dosyaListesi> <çıktıDosyası> [--categories=Security,Architecture,...]
//
// Geriye uyumluluk: ilk argüman bir subkomut adı değilse ESKİ davranış (manifest) çalışır.

if (args.Length < 2)
{
    Console.Error.WriteLine(
        "Kullanım:\n" +
        "  ContextMcp.Roslyn manifest <kaynakKök> <çıktıDosyası>\n" +
        "  ContextMcp.Roslyn review <dosyaListesi> <çıktıDosyası> [--categories=Security,Architecture,Performance,ErrorHandling]");
    return 1;
}

string subcommand;
string[] rest;
if (args[0] is "manifest" or "review")
{
    subcommand = args[0];
    rest = args.Skip(1).ToArray();
}
else
{
    // Geriye uyumluluk: <srcRoot> <outFile>
    subcommand = "manifest";
    rest = args;
}

return subcommand switch
{
    "manifest" => RunManifest(rest),
    "review" => RunReview(rest),
    _ => Fail($"Bilinmeyen subkomut: {subcommand}"),
};

static int Fail(string msg)
{
    Console.Error.WriteLine($"[ContextMcp.Roslyn] {msg}");
    return 1;
}

static int RunManifest(string[] a)
{
    if (a.Length < 2) return Fail("manifest: <kaynakKök> <çıktıDosyası> gerekli.");
    var sourceRoot = Path.GetFullPath(a[0]);
    var outputFile = Path.GetFullPath(a[1]);

    if (!Directory.Exists(sourceRoot))
        return Fail($"Kaynak dizin bulunamadı: {sourceRoot}");

    var files = new Dictionary<string, FileEntry>();
    foreach (var file in Directory.EnumerateFiles(sourceRoot, "*.cs", SearchOption.AllDirectories))
    {
        if (Extractor.IsExcluded(file)) continue;
        string text;
        try { text = File.ReadAllText(file); }
        catch { continue; }
        var tree = CSharpSyntaxTree.ParseText(text);
        var entry = Extractor.ExtractFile(tree.GetRoot(), file);
        if (entry is null) continue;
        var rel = Path.GetRelativePath(sourceRoot, file).Replace('\\', '/');
        files[rel] = entry;
    }

    var manifest = new ManifestRoot(DateTime.UtcNow.ToString("o"), sourceRoot, files);
    var json = JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true });

    Directory.CreateDirectory(Path.GetDirectoryName(outputFile)!);
    File.WriteAllText(outputFile, json);
    Console.Error.WriteLine($"[ContextMcp.Roslyn] {files.Count} dosya işlendi → {outputFile}");
    return 0;
}

static int RunReview(string[] a)
{
    if (a.Length < 2) return Fail("review: <dosyaListesi> <çıktıDosyası> gerekli.");
    var fileListPath = Path.GetFullPath(a[0]);
    var outputFile = Path.GetFullPath(a[1]);

    if (!File.Exists(fileListPath))
        return Fail($"Dosya listesi bulunamadı: {fileListPath}");

    HashSet<string>? categories = null;
    foreach (var arg in a.Skip(2))
    {
        if (arg.StartsWith("--categories="))
        {
            categories = new HashSet<string>(
                arg["--categories=".Length..]
                    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
                StringComparer.Ordinal);
        }
    }

    var paths = File.ReadAllLines(fileListPath)
        .Select(l => l.Trim())
        .Where(l => l.Length > 0 && l.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
        .Select(Path.GetFullPath)
        .ToArray();

    var findings = ReviewRunner.Run(paths, categories);

    var json = JsonSerializer.Serialize(
        findings,
        new JsonSerializerOptions
        {
            WriteIndented = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        });

    Directory.CreateDirectory(Path.GetDirectoryName(outputFile)!);
    File.WriteAllText(outputFile, json);
    Console.Error.WriteLine($"[ContextMcp.Roslyn] review: {paths.Length} dosya, {findings.Count} bulgu → {outputFile}");
    return 0;
}
