using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace ContextMcp.Roslyn.Audit.ArchGraph;

// .csproj dosyalarını recursive tara, ProjectReference graf'ını çıkar.
// Layer pattern matching: Domain/Application/Infrastructure/Api/Web

internal sealed record ProjectNode(
    string Name,
    string Path,
    string? Layer,         // "domain" | "application" | "infrastructure" | "api" | "web" | null
    List<string> References);

internal sealed record ArchGraphResult(List<ProjectNode> Projects);

internal static class ArchGraphRunner
{
    public static ArchGraphResult Run(string sourceRoot)
    {
        var projects = new List<ProjectNode>();
        var csprojFiles = Directory.EnumerateFiles(sourceRoot, "*.csproj", SearchOption.AllDirectories)
            .Where(f => !f.Replace('\\', '/').Contains("/bin/") && !f.Replace('\\', '/').Contains("/obj/"))
            .ToList();

        foreach (var path in csprojFiles)
        {
            var name = Path.GetFileNameWithoutExtension(path);
            var refs = ParseReferences(path);
            var layer = DetectLayer(name, path);
            projects.Add(new ProjectNode(name, path, layer, refs));
        }
        return new ArchGraphResult(projects);
    }

    private static List<string> ParseReferences(string csprojPath)
    {
        var refs = new List<string>();
        try
        {
            var doc = XDocument.Load(csprojPath);
            foreach (var elem in doc.Descendants("ProjectReference"))
            {
                var include = elem.Attribute("Include")?.Value;
                if (string.IsNullOrEmpty(include)) continue;
                var refName = Path.GetFileNameWithoutExtension(include.Replace('\\', '/'));
                refs.Add(refName);
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[arch-graph] csproj parse hatası ({csprojPath}): {ex.Message}");
        }
        return refs;
    }

    private static string? DetectLayer(string name, string path)
    {
        var combined = $"{name} {path}".ToLowerInvariant();
        if (Regex.IsMatch(combined, @"\bdomain\b")) return "domain";
        if (Regex.IsMatch(combined, @"\binfrastructure\b|\bpersistence\b|\bdata\b")) return "infrastructure";
        if (Regex.IsMatch(combined, @"\bapplication\b|\bservices?\b|\buse[-_]?cases\b")) return "application";
        if (Regex.IsMatch(combined, @"\bapi\b|\bcontrollers?\b|\bendpoints?\b|\bweb\b")) return "api";
        if (Regex.IsMatch(combined, @"\btests?\b|\bspec\b")) return "test";
        return null;
    }
}
