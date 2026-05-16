using System.Text.Json;
using Microsoft.CodeAnalysis.CSharp;
using DotnetManifest;

// Argümanlar: <kaynakKök> <çıktıDosyası>
if (args.Length < 2)
{
    Console.Error.WriteLine("Kullanım: DotnetManifest <kaynakKök> <çıktıDosyası>");
    return 1;
}

var sourceRoot = Path.GetFullPath(args[0]);
var outputFile = Path.GetFullPath(args[1]);

if (!Directory.Exists(sourceRoot))
{
    Console.Error.WriteLine($"[DotnetManifest] Kaynak dizin bulunamadı: {sourceRoot}");
    return 1;
}

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

var manifest = new ManifestRoot(
    DateTime.UtcNow.ToString("o"),
    sourceRoot,
    files);

var json = JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true });

Directory.CreateDirectory(Path.GetDirectoryName(outputFile)!);
File.WriteAllText(outputFile, json);

Console.Error.WriteLine($"[DotnetManifest] {files.Count} dosya işlendi → {outputFile}");
return 0;
