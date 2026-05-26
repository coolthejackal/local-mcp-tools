using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace ContextMcp.Roslyn.Review.Rules;

internal sealed class HardcodedSecretRule : IRule
{
    public string Name => "hardcoded-secret";
    public string Category => "Security";

    private static readonly (Regex regex, string label)[] Patterns = new (Regex, string)[]
    {
        (new Regex(@"AKIA[0-9A-Z]{16}", RegexOptions.Compiled), "AWS access key"),
        (new Regex(@"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----", RegexOptions.Compiled), "private key (PEM)"),
        (new Regex(@"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}", RegexOptions.Compiled), "JWT token"),
        (new Regex(@"(?:password|passwd|pwd|api[_-]?key|secret|token)\s*[:=]\s*[""'][^""'\s]{6,}[""']", RegexOptions.Compiled | RegexOptions.IgnoreCase), "credential literal"),
        (new Regex(@"(?:mongodb|postgres|postgresql|mysql|mssql|redis)://[^\s'""<>]+:[^\s'""<>]+@", RegexOptions.Compiled | RegexOptions.IgnoreCase), "DB connection string with credentials"),
    };

    public IEnumerable<Finding> Check(SyntaxTree tree, SemanticModel model, string filePath)
    {
        var root = tree.GetRoot();
        foreach (var literal in root.DescendantNodes().OfType<LiteralExpressionSyntax>())
        {
            if (!literal.IsKind(SyntaxKind.StringLiteralExpression)) continue;
            var text = literal.Token.ValueText;
            foreach (var (regex, label) in Patterns)
            {
                if (regex.IsMatch(text))
                {
                    yield return new Finding(
                        "Critical", "Security", filePath, RuleHelpers.LineOf(literal),
                        Name,
                        $"Olası hardcoded {label} string literal içinde.",
                        "Repo'ya commit edilen sırlar git history'sinde kalır; geri alınamaz, " +
                        "credential rotasyonu ve incident response gerektirir.",
                        "Sırrı environment variable veya secret manager'a (User Secrets, Azure Key Vault, " +
                        "AWS Secrets Manager) taşı; repo'dan kaldırıp anahtarı rotate et.");
                    break;
                }
            }
        }
    }
}

internal sealed class SqlInjectionRule : IRule
{
    public string Name => "sql-injection";
    public string Category => "Security";

    private static readonly Regex SqlKeyword = new(
        @"\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|UNION|DROP|ALTER|TRUNCATE)\b",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public IEnumerable<Finding> Check(SyntaxTree tree, SemanticModel model, string filePath)
    {
        var root = tree.GetRoot();

        // 1) Interpolated string SQL keyword içeriyor → injection riski
        foreach (var interp in root.DescendantNodes().OfType<InterpolatedStringExpressionSyntax>())
        {
            var rawText = interp.ToString();
            var hasInterpolation = interp.Contents.OfType<InterpolationSyntax>().Any();
            if (hasInterpolation && SqlKeyword.IsMatch(rawText))
            {
                yield return new Finding(
                    "Critical", "Security", filePath, RuleHelpers.LineOf(interp),
                    Name,
                    "Interpolated string SQL anahtar kelimesi içeriyor ve değişken interpolasyon yapıyor.",
                    "Kullanıcı girdisinin SQL'e birleştirilmesi injection açar; yetkisiz veri okuma, " +
                    "silme veya tüm tablo dökümünü mümkün kılar.",
                    "Parametre kullan: SqlCommand.Parameters.AddWithValue(...), " +
                    "Dapper named parameters, EF Core .FromSqlInterpolated yerine LINQ.");
            }
        }

        // 2) String concat (+) ile SQL inşası
        foreach (var bin in root.DescendantNodes().OfType<BinaryExpressionSyntax>())
        {
            if (!bin.IsKind(SyntaxKind.AddExpression)) continue;
            var text = bin.ToString();
            if (!SqlKeyword.IsMatch(text)) continue;

            // En az bir tarafı non-literal mi?
            bool leftLiteral = bin.Left is LiteralExpressionSyntax;
            bool rightLiteral = bin.Right is LiteralExpressionSyntax;
            if (leftLiteral && rightLiteral) continue;

            yield return new Finding(
                "Critical", "Security", filePath, RuleHelpers.LineOf(bin),
                Name,
                "SQL sorgusu string concatenation (+) ile değişken birleştiriyor.",
                "String concat ile inşa edilen SQL injection açar; yetkisiz erişim ve veri kaybı riski.",
                "Parametrik sorgu kullan veya ORM'in parametre bağlama API'sini kullan " +
                "(Dapper, EF Core, SqlParameter).");
        }
    }
}

internal sealed class WeakCryptoRule : IRule
{
    public string Name => "weak-crypto";
    public string Category => "Security";

    private static readonly HashSet<string> WeakAlgos = new(StringComparer.OrdinalIgnoreCase)
    {
        "MD5", "SHA1", "MD5CryptoServiceProvider", "SHA1CryptoServiceProvider", "SHA1Managed", "MD5Managed",
    };

    public IEnumerable<Finding> Check(SyntaxTree tree, SemanticModel model, string filePath)
    {
        var root = tree.GetRoot();

        // 1) MD5.Create() / SHA1.Create() statik çağrı
        foreach (var invocation in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            if (invocation.Expression is MemberAccessExpressionSyntax ma &&
                ma.Name.Identifier.Text == "Create" &&
                ma.Expression is IdentifierNameSyntax id &&
                WeakAlgos.Contains(id.Identifier.Text))
            {
                yield return new Finding(
                    "High", "Security", filePath, RuleHelpers.LineOf(invocation),
                    Name,
                    $"Zayıf hash algoritması: {id.Identifier.Text}.Create().",
                    "MD5/SHA1 collision saldırılarına açık; password veya integrity için kullanılırsa " +
                    "preimage bulma ve manipülasyon mümkündür.",
                    "SHA256.Create() veya daha güçlüsünü kullan. Şifre hashleme için " +
                    "Microsoft.AspNetCore.Identity.PasswordHasher (PBKDF2) veya BCrypt/Argon2 tercih et.");
            }
        }

        // 2) new MD5CryptoServiceProvider() benzeri
        foreach (var obj in root.DescendantNodes().OfType<ObjectCreationExpressionSyntax>())
        {
            var typeName = obj.Type.ToString();
            if (WeakAlgos.Contains(typeName))
            {
                yield return new Finding(
                    "High", "Security", filePath, RuleHelpers.LineOf(obj),
                    Name,
                    $"Zayıf hash algoritması: new {typeName}().",
                    "MD5/SHA1 cryptographically broken; collision saldırıları pratik.",
                    "SHA256/SHA512 kullan veya şifre için PBKDF2/Argon2.");
            }
        }
    }
}

internal sealed class MissingAuthorizeRule : IRule
{
    public string Name => "missing-authorize";
    public string Category => "Security";

    private static readonly string[] HttpVerbAttrs = { "HttpGet", "HttpPost", "HttpPut", "HttpDelete", "HttpPatch" };

    public IEnumerable<Finding> Check(SyntaxTree tree, SemanticModel model, string filePath)
    {
        var root = tree.GetRoot();

        foreach (var cls in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
        {
            // Controller mı?
            var baseTypes = cls.BaseList?.Types.Select(t => t.Type.ToString()).ToList() ?? new();
            bool isController =
                baseTypes.Contains("ControllerBase") ||
                baseTypes.Contains("Controller") ||
                cls.Identifier.Text.EndsWith("Controller");
            if (!isController) continue;

            bool classHasAuth = HasAuthAttribute(cls.AttributeLists) || HasAllowAnonymous(cls.AttributeLists);

            foreach (var method in cls.Members.OfType<MethodDeclarationSyntax>())
            {
                if (!IsPublicMethod(method)) continue;

                bool hasHttpVerb = method.AttributeLists
                    .SelectMany(al => al.Attributes)
                    .Any(a => HttpVerbAttrs.Contains(a.Name.ToString()));
                if (!hasHttpVerb) continue;

                bool methodHasAuth = HasAuthAttribute(method.AttributeLists) || HasAllowAnonymous(method.AttributeLists);

                if (!classHasAuth && !methodHasAuth)
                {
                    yield return new Finding(
                        "High", "Security", filePath, RuleHelpers.LineOf(method),
                        Name,
                        $"Action '{method.Identifier.Text}' [Authorize] / [AllowAnonymous] olmadan public endpoint.",
                        "Erişim kontrolü olmayan endpoint kimliği doğrulanmamış tüm trafiğe açıktır; " +
                        "veri sızıntısı, yetkisiz iş emri, IDOR riski.",
                        "Controller veya action'a [Authorize(...)] ekle; bilinçli olarak public ise " +
                        "[AllowAnonymous] ile niyetini ifade et.");
                }
            }
        }
    }

    private static bool HasAuthAttribute(SyntaxList<AttributeListSyntax> lists) =>
        lists.SelectMany(al => al.Attributes).Any(a =>
        {
            var n = a.Name.ToString();
            return n == "Authorize" || n.EndsWith(".Authorize");
        });

    private static bool HasAllowAnonymous(SyntaxList<AttributeListSyntax> lists) =>
        lists.SelectMany(al => al.Attributes).Any(a =>
        {
            var n = a.Name.ToString();
            return n == "AllowAnonymous" || n.EndsWith(".AllowAnonymous");
        });

    private static bool IsPublicMethod(MethodDeclarationSyntax method) =>
        method.Modifiers.Any(m => m.Text == "public");
}

internal static class SecurityRules
{
    public static readonly IRule[] All = new IRule[]
    {
        new HardcodedSecretRule(),
        new SqlInjectionRule(),
        new WeakCryptoRule(),
        new MissingAuthorizeRule(),
    };
}
