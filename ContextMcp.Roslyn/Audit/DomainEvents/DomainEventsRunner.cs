using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace ContextMcp.Roslyn.Audit.DomainEvents;

internal sealed record EventPublisher(string EventType, string File, int Line, string? Project);
internal sealed record EventConsumer(string EventType, string HandlerClass, string File, int Line, string? Project);
internal sealed record DomainEventsResult(List<EventPublisher> Publishers, List<EventConsumer> Consumers);

internal static class DomainEventsRunner
{
    // Yaygın publisher pattern'leri
    private static readonly HashSet<string> PublishMethodNames = new(StringComparer.Ordinal)
    {
        "PublishAsync", "Publish", "Send", "SendAsync", "Notify", "Dispatch", "DispatchAsync",
    };

    // Yaygın consumer interface'leri (generic)
    private static readonly HashSet<string> ConsumerInterfaces = new(StringComparer.Ordinal)
    {
        "IEventHandler", "INotificationHandler", "IConsumer", "IRequestHandler", "IDomainEventHandler",
    };

    public static DomainEventsResult Run(string sourceRoot)
    {
        var trees = new List<(SyntaxTree tree, string path, string? project)>();
        foreach (var file in Directory.EnumerateFiles(sourceRoot, "*.cs", SearchOption.AllDirectories))
        {
            if (Extractor.IsExcluded(file)) continue;
            string text;
            try { text = File.ReadAllText(file); }
            catch { continue; }
            trees.Add((CSharpSyntaxTree.ParseText(text, path: file), file, GuessProject(file, sourceRoot)));
        }
        if (trees.Count == 0) return new DomainEventsResult(new(), new());

        var refs = LoadTrustedReferences();
        var compilation = CSharpCompilation.Create(
            "ContextMcp.DomainEvents",
            trees.Select(t => t.tree),
            refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var publishers = new List<EventPublisher>();
        var consumers = new List<EventConsumer>();

        foreach (var (tree, path, project) in trees)
        {
            var model = compilation.GetSemanticModel(tree);
            var root = tree.GetRoot();

            // Publishers: <bus>.PublishAsync<T>(...) generic invocations
            foreach (var inv in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (inv.Expression is not MemberAccessExpressionSyntax mae) continue;
                string methodName = mae.Name is GenericNameSyntax gn ? gn.Identifier.Text : mae.Name.Identifier.Text;
                if (!PublishMethodNames.Contains(methodName)) continue;

                // Generic argümandan event type'ı çıkar
                string? eventType = null;
                if (mae.Name is GenericNameSyntax gnTypeArgs && gnTypeArgs.TypeArgumentList.Arguments.Count == 1)
                {
                    eventType = gnTypeArgs.TypeArgumentList.Arguments[0].ToString();
                }
                else if (inv.ArgumentList.Arguments.Count > 0)
                {
                    // Generic değil, argümanın type'ından çıkarmaya çalış
                    var first = inv.ArgumentList.Arguments[0].Expression;
                    var info = model.GetTypeInfo(first);
                    eventType = info.Type?.Name;
                }
                if (string.IsNullOrEmpty(eventType)) continue;

                publishers.Add(new EventPublisher(
                    EventType: eventType!,
                    File: path,
                    Line: inv.GetLocation().GetLineSpan().StartLinePosition.Line + 1,
                    Project: project));
            }

            // Consumers: class C : IEventHandler<E>
            foreach (var cls in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
            {
                if (cls.BaseList is null) continue;
                foreach (var baseType in cls.BaseList.Types)
                {
                    if (baseType.Type is not GenericNameSyntax gn) continue;
                    if (!ConsumerInterfaces.Contains(gn.Identifier.Text)) continue;
                    if (gn.TypeArgumentList.Arguments.Count != 1) continue;
                    var eventType = gn.TypeArgumentList.Arguments[0].ToString();
                    consumers.Add(new EventConsumer(
                        EventType: eventType,
                        HandlerClass: cls.Identifier.Text,
                        File: path,
                        Line: cls.GetLocation().GetLineSpan().StartLinePosition.Line + 1,
                        Project: project));
                }
            }
        }

        return new DomainEventsResult(publishers, consumers);
    }

    private static string? GuessProject(string file, string sourceRoot)
    {
        // Path'te bir .csproj'a en yakın klasör adını al
        var dir = Path.GetDirectoryName(file);
        while (!string.IsNullOrEmpty(dir) && dir.StartsWith(sourceRoot, StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                if (Directory.EnumerateFiles(dir, "*.csproj").Any())
                    return Path.GetFileName(dir);
            }
            catch { /* ignore */ }
            dir = Path.GetDirectoryName(dir);
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
