using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace ContextMcp.Roslyn.Audit.TenantIsolation;

// Entity-bazlı tenant isolation analizi:
// - DbContext'leri bul, OnModelCreating'deki HasQueryFilter zincirlerini çıkar
// - DbSet<T> entity'leri için: T'de TenantId property'si var mı, filter ekli mi?
// - .IgnoreQueryFilters() çağrılarını ve hemen üstündeki yorum durumunu yakala

internal sealed record TenantIsolationResult(
    [property: JsonPropertyName("entities")] List<EntityRecord> Entities,
    [property: JsonPropertyName("ignoreCalls")] List<IgnoreCall> IgnoreCalls);

internal sealed record EntityRecord(
    string Name,
    bool HasTenantIdProperty,
    bool HasQueryFilter,
    bool FilterMentionsTenantId,
    string? DbContextName,
    string? File,
    int Line);

internal sealed record IgnoreCall(
    string File,
    int Line,
    bool HasPrecedingComment);

internal static class TenantIsolationRunner
{
    private static readonly HashSet<string> TenantIdPropertyNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "TenantId", "WorkspaceId", "OrganizationId", "TenantID", "tenant_id",
    };

    public static TenantIsolationResult Run(string sourceRoot)
    {
        var trees = new List<(SyntaxTree tree, string path)>();
        foreach (var file in Directory.EnumerateFiles(sourceRoot, "*.cs", SearchOption.AllDirectories))
        {
            if (Extractor.IsExcluded(file)) continue;
            string text;
            try { text = File.ReadAllText(file); }
            catch { continue; }
            trees.Add((CSharpSyntaxTree.ParseText(text, path: file), file));
        }
        if (trees.Count == 0) return new TenantIsolationResult(new(), new());

        var refs = LoadTrustedReferences();
        var compilation = CSharpCompilation.Create(
            "ContextMcp.TenantIsolation",
            trees.Select(t => t.tree),
            refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        // Pass 1: Tüm entity tiplerini tara → TenantId property'si var mı
        var entityHasTenantId = new Dictionary<string, (string file, int line)>(StringComparer.Ordinal);
        foreach (var (tree, path) in trees)
        {
            foreach (var cls in tree.GetRoot().DescendantNodes().OfType<ClassDeclarationSyntax>())
            {
                if (HasTenantIdProperty(cls))
                {
                    var line = cls.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
                    entityHasTenantId[cls.Identifier.Text] = (path, line);
                }
            }
        }

        // Pass 2: DbContext'leri ve HasQueryFilter zincirlerini bul
        var filtered = new Dictionary<string, (string dbContext, bool mentionsTenantId)>(StringComparer.Ordinal);
        foreach (var (tree, path) in trees)
        {
            var model = compilation.GetSemanticModel(tree);
            foreach (var cls in tree.GetRoot().DescendantNodes().OfType<ClassDeclarationSyntax>())
            {
                if (!IsDbContext(cls)) continue;
                var dbCtxName = cls.Identifier.Text;
                foreach (var method in cls.Members.OfType<MethodDeclarationSyntax>())
                {
                    if (method.Identifier.Text != "OnModelCreating") continue;
                    foreach (var inv in method.DescendantNodes().OfType<InvocationExpressionSyntax>())
                    {
                        if (inv.Expression is not MemberAccessExpressionSyntax mae) continue;
                        if (mae.Name.Identifier.Text != "HasQueryFilter") continue;

                        var entityName = ResolveEntityFromChain(mae.Expression);
                        if (entityName is null) continue;

                        var filterText = inv.ArgumentList.ToString();
                        bool mentions = TenantIdPropertyNames.Any(n =>
                            filterText.Contains(n, StringComparison.OrdinalIgnoreCase));
                        filtered[entityName] = (dbCtxName, mentions);
                    }
                }
            }
        }

        // Pass 3: IgnoreQueryFilters çağrıları
        var ignoreCalls = new List<IgnoreCall>();
        foreach (var (tree, path) in trees)
        {
            var lines = tree.GetText().Lines;
            foreach (var inv in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (inv.Expression is not MemberAccessExpressionSyntax mae) continue;
                if (mae.Name.Identifier.Text != "IgnoreQueryFilters") continue;

                var span = inv.GetLocation().GetLineSpan();
                int lineNum = span.StartLinePosition.Line + 1;

                // Hemen üstündeki satırda yorum var mı?
                bool hasComment = false;
                if (lineNum >= 2)
                {
                    var prev = lines[lineNum - 2].ToString().TrimStart();
                    hasComment = prev.StartsWith("//") || prev.StartsWith("/*");
                }
                ignoreCalls.Add(new IgnoreCall(path, lineNum, hasComment));
            }
        }

        // Entity raporları
        var entities = new List<EntityRecord>();
        foreach (var (entityName, info) in entityHasTenantId)
        {
            var hasFilter = filtered.TryGetValue(entityName, out var f);
            entities.Add(new EntityRecord(
                Name: entityName,
                HasTenantIdProperty: true,
                HasQueryFilter: hasFilter,
                FilterMentionsTenantId: hasFilter && f.mentionsTenantId,
                DbContextName: hasFilter ? f.dbContext : null,
                File: info.file,
                Line: info.line));
        }
        // Filter var ama entity'de TenantId yok → ayrı listelenmesi de mümkün; şimdilik atla.

        return new TenantIsolationResult(entities, ignoreCalls);
    }

    private static bool HasTenantIdProperty(ClassDeclarationSyntax cls) =>
        cls.Members.OfType<PropertyDeclarationSyntax>()
            .Any(p => TenantIdPropertyNames.Contains(p.Identifier.Text));

    private static bool IsDbContext(ClassDeclarationSyntax cls)
    {
        var baseTypes = cls.BaseList?.Types.Select(t => t.Type.ToString()).ToList() ?? new();
        return baseTypes.Any(b => b == "DbContext" || b.EndsWith("DbContext"));
    }

    // modelBuilder.Entity<MyEntity>() veya modelBuilder.Entity<MyEntity>().Property(...)
    private static string? ResolveEntityFromChain(ExpressionSyntax expr)
    {
        SyntaxNode? cur = expr;
        while (cur != null)
        {
            if (cur is InvocationExpressionSyntax inv)
            {
                if (inv.Expression is MemberAccessExpressionSyntax mae &&
                    mae.Name is GenericNameSyntax gn &&
                    gn.Identifier.Text == "Entity" &&
                    gn.TypeArgumentList.Arguments.Count == 1)
                {
                    return gn.TypeArgumentList.Arguments[0].ToString();
                }
                if (inv.Expression is MemberAccessExpressionSyntax mae2)
                {
                    cur = mae2.Expression;
                    continue;
                }
            }
            if (cur is MemberAccessExpressionSyntax m)
            {
                cur = m.Expression;
                continue;
            }
            break;
        }
        return null;
    }

    private static IEnumerable<MetadataReference> LoadTrustedReferences()
    {
        var refs = new List<MetadataReference>();
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (tpa is null) return refs;
        foreach (var p in tpa.Split(Path.PathSeparator))
        {
            try { if (File.Exists(p)) refs.Add(MetadataReference.CreateFromFile(p)); }
            catch { }
        }
        return refs;
    }
}
