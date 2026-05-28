using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using ContextMcp.Roslyn.Review;

namespace ContextMcp.Roslyn.Audit.DatabaseAudit;

// EF Core odaklı database kuralları:
//   missing-index             High    Where(x => x.Y == ...) kullanılan kolon HasIndex/[Index]'te yok
//   from-sql-raw-unsafe       High    FromSqlRaw / ExecuteSqlRaw + concat veya interpolated string
//   destructive-migration-step High   Up()'ta DropColumn/DropTable + yorum yok
//   missing-asnotracking      Medium  ToListAsync/ToArrayAsync sonuç dönen sorguda .AsNoTracking() yok
//   n-plus-one-foreach        Medium  foreach içinde DbContext sorgusu
//
// Tenant filter kuralları tenant_isolation_audit'te — burada DEĞİL.

internal static class DatabaseAuditRunner
{
    private const string Category = "Database";

    private static readonly HashSet<string> ReadOnlyTerminalOps = new(StringComparer.Ordinal)
    {
        "ToListAsync", "ToArrayAsync", "ToDictionaryAsync", "ToHashSetAsync",
        "FirstAsync", "FirstOrDefaultAsync", "SingleAsync", "SingleOrDefaultAsync",
        "CountAsync", "LongCountAsync", "AnyAsync", "AllAsync",
        "MinAsync", "MaxAsync", "SumAsync", "AverageAsync",
    };

    public static List<Finding> Run(string sourceRoot)
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
        if (trees.Count == 0) return new List<Finding>();

        var refs = LoadTrustedReferences();
        var compilation = CSharpCompilation.Create(
            "ContextMcp.Database",
            trees.Select(t => t.tree),
            refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        // Pass 1: HasIndex / [Index] envanteri — Dictionary<entityName, Set<columnName>>
        var indexedColumns = BuildIndexInventory(trees);

        // Pass 2: DbSet<T> property → entity tip adı
        var dbSetEntities = BuildDbSetMap(trees);

        var findings = new List<Finding>();
        foreach (var (tree, path) in trees)
        {
            SemanticModel model;
            try { model = compilation.GetSemanticModel(tree); }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[db-audit] semantic model alınamadı ({path}): {ex.Message}");
                continue;
            }
            try
            {
                findings.AddRange(CheckMissingIndex(tree, model, path, indexedColumns, dbSetEntities));
                findings.AddRange(CheckFromSqlRawUnsafe(tree, path));
                findings.AddRange(CheckDestructiveMigration(tree, path));
                findings.AddRange(CheckMissingAsNoTracking(tree, model, path, dbSetEntities));
                findings.AddRange(CheckNPlusOne(tree, path, dbSetEntities));
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[db-audit] kural hatası ({path}): {ex.Message}");
            }
        }
        return findings;
    }

    // ─── 1) Index envanteri ────────────────────────────────────────────────
    // İki kaynak:
    //   a) modelBuilder.Entity<T>().HasIndex(x => x.Y) — fluent API
    //   b) [Index(nameof(X.Y))] / [Index("Y")] entity üstünde
    private static Dictionary<string, HashSet<string>> BuildIndexInventory(
        IReadOnlyCollection<(SyntaxTree tree, string path)> trees)
    {
        var inventory = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);

        void Add(string entity, string column)
        {
            if (!inventory.TryGetValue(entity, out var set))
            {
                set = new HashSet<string>(StringComparer.Ordinal);
                inventory[entity] = set;
            }
            set.Add(column);
        }

        foreach (var (tree, _) in trees)
        {
            var root = tree.GetRoot();

            // (a) Fluent HasIndex
            foreach (var inv in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (inv.Expression is not MemberAccessExpressionSyntax mae) continue;
                if (mae.Name.Identifier.Text != "HasIndex") continue;

                var entityName = ResolveEntityFromChain(mae.Expression);
                if (entityName is null) continue;

                // HasIndex(x => x.Y) veya HasIndex(x => new { x.Y, x.Z })
                if (inv.ArgumentList.Arguments.Count == 0) continue;
                var lambda = inv.ArgumentList.Arguments[0].Expression;
                if (lambda is SimpleLambdaExpressionSyntax simple)
                {
                    foreach (var col in ExtractColumnsFromLambdaBody(simple.Body))
                        Add(entityName, col);
                }
            }

            // (b) [Index(...)] entity üstünde
            foreach (var cls in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
            {
                var attrs = cls.AttributeLists.SelectMany(al => al.Attributes)
                    .Where(a => a.Name.ToString() == "Index" || a.Name.ToString().EndsWith(".Index"));
                foreach (var attr in attrs)
                {
                    if (attr.ArgumentList is null) continue;
                    foreach (var arg in attr.ArgumentList.Arguments)
                    {
                        // nameof(X.Foo) veya "Foo"
                        string? col = null;
                        if (arg.Expression is InvocationExpressionSyntax nameOf &&
                            nameOf.Expression is IdentifierNameSyntax id && id.Identifier.Text == "nameof" &&
                            nameOf.ArgumentList.Arguments.Count > 0)
                        {
                            var inner = nameOf.ArgumentList.Arguments[0].Expression;
                            col = inner is MemberAccessExpressionSyntax m ? m.Name.Identifier.Text :
                                  inner is IdentifierNameSyntax i ? i.Identifier.Text : null;
                        }
                        else if (arg.Expression is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.StringLiteralExpression))
                        {
                            col = lit.Token.ValueText;
                        }
                        if (!string.IsNullOrEmpty(col)) Add(cls.Identifier.Text, col!);
                    }
                }
            }
        }
        return inventory;
    }

    private static IEnumerable<string> ExtractColumnsFromLambdaBody(CSharpSyntaxNode body)
    {
        // x => x.Y          → MemberAccessExpression
        // x => new { x.Y }  → AnonymousObjectCreationExpression
        if (body is MemberAccessExpressionSyntax m)
        {
            yield return m.Name.Identifier.Text;
        }
        else if (body is AnonymousObjectCreationExpressionSyntax anon)
        {
            foreach (var init in anon.Initializers)
            {
                if (init.Expression is MemberAccessExpressionSyntax mm)
                    yield return mm.Name.Identifier.Text;
                else if (init.NameEquals?.Name is IdentifierNameSyntax id)
                    yield return id.Identifier.Text;
            }
        }
    }

    // (Tenant isolation runner'dan da kullanılan kalıp)
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

    // ─── 2) DbSet<T> property haritası ──────────────────────────────────────
    private static Dictionary<string, string> BuildDbSetMap(
        IReadOnlyCollection<(SyntaxTree tree, string path)> trees)
    {
        // Property adı → entity tip adı (örn: "Users" → "User")
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (tree, _) in trees)
        {
            foreach (var prop in tree.GetRoot().DescendantNodes().OfType<PropertyDeclarationSyntax>())
            {
                if (prop.Type is not GenericNameSyntax gn) continue;
                if (gn.Identifier.Text != "DbSet") continue;
                if (gn.TypeArgumentList.Arguments.Count != 1) continue;
                map[prop.Identifier.Text] = gn.TypeArgumentList.Arguments[0].ToString();
            }
        }
        return map;
    }

    // ─── 3) missing-index ──────────────────────────────────────────────────
    private static IEnumerable<Finding> CheckMissingIndex(
        SyntaxTree tree,
        SemanticModel model,
        string path,
        Dictionary<string, HashSet<string>> indexedColumns,
        Dictionary<string, string> dbSetEntities)
    {
        // Bu çok büyük bir log üretmesin diye aynı (entity, column) kombinasyonunu bir kez raporla.
        var reported = new HashSet<string>(StringComparer.Ordinal);

        foreach (var inv in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            if (inv.Expression is not MemberAccessExpressionSyntax mae) continue;
            if (mae.Name.Identifier.Text != "Where") continue;
            if (inv.ArgumentList.Arguments.Count == 0) continue;

            // Receiver tarafından entity tipini tahmin et (db.Foo.Where(...))
            string? entityName = null;
            if (mae.Expression is MemberAccessExpressionSyntax recv &&
                dbSetEntities.TryGetValue(recv.Name.Identifier.Text, out var t))
            {
                entityName = t;
            }
            else if (mae.Expression is IdentifierNameSyntax idn &&
                     dbSetEntities.TryGetValue(idn.Identifier.Text, out var t2))
            {
                entityName = t2;
            }
            // Daha derin chain'ler (db.Foo.Include(...).Where(...)) için semantic model kullan
            if (entityName is null)
            {
                var typeInfo = model.GetTypeInfo(mae.Expression);
                var named = typeInfo.Type as INamedTypeSymbol;
                if (named?.Name == "IQueryable" && named.TypeArguments.Length == 1)
                    entityName = named.TypeArguments[0].Name;
            }
            if (entityName is null) continue;

            // Lambda'dan kolon(lar) çıkar
            var lambda = inv.ArgumentList.Arguments[0].Expression;
            if (lambda is not SimpleLambdaExpressionSyntax sl) continue;
            var columns = ExtractColumnsFromPredicateBody(sl.Body).ToList();
            if (columns.Count == 0) continue;

            indexedColumns.TryGetValue(entityName, out var indexed);

            foreach (var col in columns)
            {
                // Primary key'leri sayma — id kolonları zaten indexli (kabaca)
                if (string.Equals(col, "Id", StringComparison.Ordinal)) continue;
                if (col.EndsWith("Id", StringComparison.Ordinal) && col.Length > 2 && char.IsUpper(col[0])) continue;
                // TenantId — tenant_isolation'a ait
                if (col == "TenantId" || col == "WorkspaceId" || col == "OrganizationId") continue;

                if (indexed != null && indexed.Contains(col)) continue;

                var key = $"{entityName}.{col}";
                if (!reported.Add(key)) continue;

                yield return new Finding(
                    "High", Category, path,
                    inv.GetLocation().GetLineSpan().StartLinePosition.Line + 1,
                    "missing-index",
                    $"Where('{col}') kolonu üzerinde filtreleme yapıyor ama '{entityName}.{col}' için HasIndex/[Index] tanımlı değil.",
                    "Indexsiz kolon üzerinde Where → full table scan. Büyük tablolarda response time " +
                    "saniyelerden onlarca saniyeye çıkabilir; production performansını ciddi düşürür.",
                    $"OnModelCreating'de: modelBuilder.Entity<{entityName}>().HasIndex(x => x.{col}). " +
                    "Composite index gerekiyorsa x => new { x.A, x.B }. Ardından migration ekle.");
            }
        }
    }

    // Predicate body'sinden kolon adlarını çıkar — basit pattern
    private static IEnumerable<string> ExtractColumnsFromPredicateBody(CSharpSyntaxNode body)
    {
        // x => x.Foo == ... veya x => x.Foo.HasValue ... veya kombinasyonlar
        // Yalnız "x.Property" şeklindeki MemberAccess'leri çıkar
        foreach (var ma in body.DescendantNodesAndSelf().OfType<MemberAccessExpressionSyntax>())
        {
            if (ma.Expression is IdentifierNameSyntax) // x.Property
            {
                yield return ma.Name.Identifier.Text;
            }
        }
    }

    // ─── 4) FromSqlRaw / ExecuteSqlRaw — unsafe pattern ─────────────────────
    private static IEnumerable<Finding> CheckFromSqlRawUnsafe(SyntaxTree tree, string path)
    {
        foreach (var inv in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            if (inv.Expression is not MemberAccessExpressionSyntax mae) continue;
            var methodName = mae.Name.Identifier.Text;
            if (methodName != "FromSqlRaw" && methodName != "ExecuteSqlRaw" && methodName != "ExecuteSqlRawAsync") continue;
            if (inv.ArgumentList.Arguments.Count == 0) continue;

            var firstArg = inv.ArgumentList.Arguments[0].Expression;
            bool isSafe =
                firstArg is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.StringLiteralExpression);

            // Interpolated string veya BinaryExpression(+) → unsafe (parametrik değil)
            if (!isSafe)
            {
                yield return new Finding(
                    "High", Category, path,
                    inv.GetLocation().GetLineSpan().StartLinePosition.Line + 1,
                    "from-sql-raw-unsafe",
                    $"{methodName} parametrik olmayan bir string ile çağrılıyor.",
                    "Doğrudan string concat veya interpolation SQL injection'a açar; FromSqlRaw " +
                    "parametre güvenliği sağlamaz, FromSqlInterpolated ise altta parametrize eder " +
                    "ancak yine raw kullanım sırasında dikkat gerekir.",
                    "FromSqlInterpolated($\"... {value}\") kullan (EF otomatik parametrize eder), " +
                    "veya FromSqlRaw'da parametre listesi ver: FromSqlRaw(\"... {0}\", value).");
            }
        }
    }

    // ─── 5) Destructive migration step ─────────────────────────────────────
    private static IEnumerable<Finding> CheckDestructiveMigration(SyntaxTree tree, string path)
    {
        // Migration dosyaları tipik olarak Migrations/ klasöründe ve XxxMigration : Migration türevidir.
        var rel = path.Replace('\\', '/');
        if (!rel.Contains("/Migrations/", StringComparison.OrdinalIgnoreCase)) yield break;

        var root = tree.GetRoot();
        var lines = tree.GetText().Lines;

        foreach (var method in root.DescendantNodes().OfType<MethodDeclarationSyntax>())
        {
            if (method.Identifier.Text != "Up") continue;

            foreach (var inv in method.DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (inv.Expression is not MemberAccessExpressionSyntax mae) continue;
                var op = mae.Name.Identifier.Text;
                if (op != "DropColumn" && op != "DropTable" && op != "DropForeignKey" &&
                    op != "DropPrimaryKey" && op != "DropIndex") continue;

                var lineNum = inv.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
                bool hasComment = false;
                if (lineNum >= 2)
                {
                    var prev = lines[lineNum - 2].ToString().TrimStart();
                    hasComment = prev.StartsWith("//") || prev.StartsWith("/*");
                }
                if (hasComment) continue;

                yield return new Finding(
                    "High", Category, path, lineNum,
                    "destructive-migration-step",
                    $"Migration Up()'ta {op} çağrısı yorum olmadan kullanılıyor.",
                    "Destructive migration (DropColumn/DropTable/DropForeignKey) production'da veri " +
                    "kaybına yol açabilir; bilinçsiz uygulanırsa geri alınamaz hasar verir. " +
                    "Code review'da niyetin neden olduğu net olmalı.",
                    $"Satırın üstüne kısa bir gerekçe yorumu yaz (örn: '// Removing legacy column X — " +
                    "data migrated in MigrationN'). Mümkünse veri taşıma adımı (Sql) ile birlikte gönder.");
            }
        }
    }

    // ─── 6) missing-asnotracking ───────────────────────────────────────────
    private static IEnumerable<Finding> CheckMissingAsNoTracking(
        SyntaxTree tree,
        SemanticModel model,
        string path,
        Dictionary<string, string> dbSetEntities)
    {
        // Read-only sorgu pattern'i:
        //   await db.Foo.Where(...).ToListAsync()  (no .AsNoTracking())
        //   await db.Foo.FirstOrDefaultAsync(...)
        // Burada false positive azaltma: salt terminal call'u ele alıyoruz.
        foreach (var inv in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            if (inv.Expression is not MemberAccessExpressionSyntax mae) continue;
            if (!ReadOnlyTerminalOps.Contains(mae.Name.Identifier.Text)) continue;

            // Zincirin başlangıcında DbSet erişimi var mı?
            var chain = WalkChain(mae.Expression).ToList();
            bool startsWithDbSet = chain.Any(c =>
                c is MemberAccessExpressionSyntax mm && dbSetEntities.ContainsKey(mm.Name.Identifier.Text));
            if (!startsWithDbSet)
            {
                // Veya semantic model: tip IQueryable<T> mi?
                var info = model.GetTypeInfo(mae.Expression);
                if (info.Type is not INamedTypeSymbol n || n.Name != "IQueryable") continue;
            }

            // .AsNoTracking() zincirde var mı?
            bool hasAsNoTracking = chain.Any(c =>
                c is InvocationExpressionSyntax i &&
                i.Expression is MemberAccessExpressionSyntax m2 &&
                (m2.Name.Identifier.Text == "AsNoTracking" || m2.Name.Identifier.Text == "AsNoTrackingWithIdentityResolution"));
            if (hasAsNoTracking) continue;

            yield return new Finding(
                "Medium", Category, path,
                inv.GetLocation().GetLineSpan().StartLinePosition.Line + 1,
                "missing-asnotracking",
                $"DbSet sorgusu .AsNoTracking() olmadan {mae.Name.Identifier.Text} ile sonuçlanıyor.",
                "Tracking varsayılan aktif — entity'ler change tracker'a girer, memory ve CPU kullanır. " +
                "Read-only sorgular için gereksiz; özellikle ToListAsync ile büyük sonuçlarda performans " +
                "kaybı yüzde 30+ olabilir.",
                "Salt-okunur sorgularda .AsNoTracking() ekle: db.X.AsNoTracking().Where(...).ToListAsync(). " +
                "Tek kayıt güncelleme niyeti yoksa default'u AsNoTracking yapabilirsin: " +
                "ChangeTracker.QueryTrackingBehavior = NoTracking.");
        }
    }

    private static IEnumerable<SyntaxNode> WalkChain(ExpressionSyntax start)
    {
        SyntaxNode? cur = start;
        while (cur != null)
        {
            yield return cur;
            if (cur is InvocationExpressionSyntax inv && inv.Expression is MemberAccessExpressionSyntax mae)
            {
                cur = mae.Expression;
            }
            else if (cur is MemberAccessExpressionSyntax m)
            {
                cur = m.Expression;
            }
            else
            {
                yield break;
            }
        }
    }

    // ─── 7) N+1 foreach heuristic ──────────────────────────────────────────
    private static IEnumerable<Finding> CheckNPlusOne(
        SyntaxTree tree,
        string path,
        Dictionary<string, string> dbSetEntities)
    {
        foreach (var foreachStmt in tree.GetRoot().DescendantNodes().OfType<ForEachStatementSyntax>())
        {
            // foreach body içinde DbSet üzerinden invocation var mı?
            foreach (var inv in foreachStmt.Statement.DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (inv.Expression is not MemberAccessExpressionSyntax mae) continue;
                if (!ReadOnlyTerminalOps.Contains(mae.Name.Identifier.Text)) continue;

                var chain = WalkChain(mae.Expression).ToList();
                bool startsWithDbSet = chain.Any(c =>
                    c is MemberAccessExpressionSyntax mm && dbSetEntities.ContainsKey(mm.Name.Identifier.Text));
                if (!startsWithDbSet) continue;

                yield return new Finding(
                    "Medium", Category, path,
                    inv.GetLocation().GetLineSpan().StartLinePosition.Line + 1,
                    "n-plus-one-foreach",
                    $"foreach içinde DbContext sorgusu (.{mae.Name.Identifier.Text}) — olası N+1.",
                    "Her iterasyon için ayrı DB roundtrip — N kayıt için N+1 sorgu. Latency × N büyür, " +
                    "DB connection pool tükenir. Production'da en yaygın yavaşlık sebebi.",
                    "İlişkileri tek sorguda yükle: .Include(x => x.Related) veya GroupBy/Join ile " +
                    "batch sorgu. Liste karşılaştırması gerekiyorsa önce ID'leri Contains() ile " +
                    "tek sorguda çek.");
                break;  // bir foreach için bir bulgu yeterli
            }
        }
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
