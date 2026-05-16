using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace DotnetManifest;

internal static class Extractor
{
    public static bool IsExcluded(string path)
    {
        var p = path.Replace('\\', '/');
        return p.Contains("/bin/") || p.Contains("/obj/") || p.Contains("/node_modules/");
    }

    public static FileEntry? ExtractFile(SyntaxNode root, string filePath)
    {
        var types = root.DescendantNodes().OfType<TypeDeclarationSyntax>().ToList();
        if (types.Count == 0) return null;

        var functions = new List<FuncEntry>();
        var exports = new List<string>();
        var dependencies = new List<string>();

        foreach (var type in types)
        {
            var typeName = type.Identifier.Text;

            // public tip → export
            if (HasModifier(type.Modifiers, "public"))
                exports.Add(typeName);

            // DI: primary constructor parametreleri (C# 12 / record)
            if (type.ParameterList is not null)
                foreach (var p in type.ParameterList.Parameters)
                    if (p.Type is not null)
                        dependencies.Add(p.Type.ToString());

            // record positional parametreleri → sözde fonksiyon (DTO şekli görünsün)
            if (type is RecordDeclarationSyntax && type.ParameterList is not null)
            {
                var recParams = type.ParameterList.Parameters
                    .Select(p => $"{p.Identifier.Text}: {p.Type}")
                    .ToList();
                functions.Add(new FuncEntry(typeName, typeName, recParams, "record",
                    new List<string>(), new List<string>()));
            }

            foreach (var member in type.Members)
            {
                if (member is ConstructorDeclarationSyntax ctor)
                {
                    foreach (var p in ctor.ParameterList.Parameters)
                        if (p.Type is not null)
                            dependencies.Add(p.Type.ToString());
                }
                else if (member is MethodDeclarationSyntax method)
                {
                    functions.Add(ExtractMethod(method, typeName));
                }
            }
        }

        return new FileEntry(
            Classify(types[0], filePath),
            functions,
            exports.Distinct().ToList(),
            dependencies.Distinct().ToList());
    }

    private static FuncEntry ExtractMethod(MethodDeclarationSyntax method, string className)
    {
        var prms = method.ParameterList.Parameters
            .Select(p => p.Type is not null ? $"{p.Identifier.Text}: {p.Type}" : p.Identifier.Text)
            .ToList();

        var attributes = method.AttributeLists
            .SelectMany(al => al.Attributes)
            .Select(a => a.ToString())
            .ToList();

        var calls = method.DescendantNodes()
            .OfType<InvocationExpressionSyntax>()
            .Select(inv => CallName(inv.Expression))
            .Where(n => n is not null)
            .Select(n => n!)
            .Distinct()
            .ToList();

        return new FuncEntry(
            method.Identifier.Text,
            className,
            prms,
            method.ReturnType.ToString(),
            attributes,
            calls);
    }

    private static string? CallName(ExpressionSyntax expr) => expr switch
    {
        MemberAccessExpressionSyntax m => m.Name.Identifier.Text,
        IdentifierNameSyntax id => id.Identifier.Text,
        _ => null,
    };

    private static string Classify(TypeDeclarationSyntax type, string filePath)
    {
        var name = type.Identifier.Text;
        var path = filePath.Replace('\\', '/');

        var baseTypes = type.BaseList?.Types.Select(t => t.Type.ToString()).ToList()
                        ?? new List<string>();
        var attrs = type.AttributeLists.SelectMany(al => al.Attributes)
            .Select(a => a.Name.ToString()).ToList();

        bool BaseStartsWith(string prefix) =>
            baseTypes.Any(b => b == prefix || b.StartsWith(prefix + "<"));

        if (type is InterfaceDeclarationSyntax) return "interface";
        if (baseTypes.Contains("ControllerBase") || baseTypes.Contains("Controller")
            || attrs.Contains("ApiController") || name.EndsWith("Controller"))
            return "controller";
        if (BaseStartsWith("Hub")) return "hub";
        if (baseTypes.Contains("DbContext")) return "dbcontext";
        if (type is RecordDeclarationSyntax
            || name.EndsWith("Dto") || name.EndsWith("Request") || name.EndsWith("Response"))
            return "dto";
        if (name.EndsWith("Service")) return "service";
        if (name.EndsWith("Repository")) return "repository";
        if (path.Contains("/Domain/") || path.Contains("/Entities/") || path.Contains("/Models/"))
            return "entity";
        return "other";
    }

    private static bool HasModifier(SyntaxTokenList mods, string keyword) =>
        mods.Any(m => m.Text == keyword);
}
