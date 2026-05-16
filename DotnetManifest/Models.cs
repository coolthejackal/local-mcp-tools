namespace DotnetManifest;

// JSON çıktısı mcp-index.json formatıyla uyumlu — alan adları TypeScript manifest'i ile aynı.

internal sealed record ManifestRoot(
    string generated,
    string root,
    Dictionary<string, FileEntry> files);

internal sealed record FileEntry(
    string kind,
    List<FuncEntry> functions,
    List<string> exports,
    List<string> dependencies);

internal sealed record FuncEntry(
    string name,
    string @class,
    List<string> @params,
    string returns,
    List<string> attributes,
    List<string> calls);
