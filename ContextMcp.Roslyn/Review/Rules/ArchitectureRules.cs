using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace ContextMcp.Roslyn.Review.Rules;

internal sealed class GodClassRule : IRule
{
    public string Name => "god-class";
    public string Category => "Architecture";

    private const int LineThreshold = 500;
    private const int MemberThreshold = 20;

    public IEnumerable<Finding> Check(SyntaxTree tree, SemanticModel model, string filePath)
    {
        var root = tree.GetRoot();
        foreach (var cls in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
        {
            var span = cls.GetLocation().GetLineSpan();
            var lines = span.EndLinePosition.Line - span.StartLinePosition.Line + 1;
            var memberCount = cls.Members.Count(m =>
                m is MethodDeclarationSyntax ||
                m is PropertyDeclarationSyntax ||
                m is FieldDeclarationSyntax);

            if (lines > LineThreshold || memberCount > MemberThreshold)
            {
                yield return new Finding(
                    "Medium", "Architecture", filePath, RuleHelpers.LineOf(cls),
                    Name,
                    $"Sınıf '{cls.Identifier.Text}' çok büyük: {lines} satır, {memberCount} üye.",
                    "God class SRP'yi ihlal eder; test edilmesi ve değiştirilmesi zorlaşır, " +
                    "merge çakışmaları artar, yan etkiler izlenemez.",
                    "Sınıfı sorumluluğa göre böl (validator, repository, mapper). " +
                    "Composition tercih et; partial class veya bağımlılık enjeksiyonu ile yeniden organize et.");
            }
        }
    }
}

internal sealed class LongMethodRule : IRule
{
    public string Name => "long-method";
    public string Category => "Architecture";

    private const int LineThreshold = 100;

    public IEnumerable<Finding> Check(SyntaxTree tree, SemanticModel model, string filePath)
    {
        var root = tree.GetRoot();
        foreach (var method in root.DescendantNodes().OfType<MethodDeclarationSyntax>())
        {
            if (method.Body is null) continue;
            var span = method.GetLocation().GetLineSpan();
            var lines = span.EndLinePosition.Line - span.StartLinePosition.Line + 1;
            if (lines > LineThreshold)
            {
                yield return new Finding(
                    "Medium", "Architecture", filePath, RuleHelpers.LineOf(method),
                    Name,
                    $"Metod '{method.Identifier.Text}' {lines} satır — uzun.",
                    "Uzun metodlar tek bakışta anlaşılmaz; cyclomatic complexity yüksek olur, " +
                    "test coverage düşer ve regresyon riski artar.",
                    "Mantıksal bloklara göre private helper'lara ayır; extract method refactoring uygula.");
            }
        }
    }
}

internal sealed class TooManyParamsRule : IRule
{
    public string Name => "too-many-params";
    public string Category => "Architecture";

    private const int Threshold = 5;

    public IEnumerable<Finding> Check(SyntaxTree tree, SemanticModel model, string filePath)
    {
        var root = tree.GetRoot();

        foreach (var method in root.DescendantNodes().OfType<MethodDeclarationSyntax>())
        {
            if (method.ParameterList.Parameters.Count > Threshold)
            {
                yield return new Finding(
                    "Low", "Architecture", filePath, RuleHelpers.LineOf(method),
                    Name,
                    $"'{method.Identifier.Text}' {method.ParameterList.Parameters.Count} parametre alıyor.",
                    "Çok sayıda parametre data clump / feature envy sinyalidir; çağrı noktalarında " +
                    "yanlış sıra ile hata yapma olasılığı artar.",
                    "İlişkili parametreleri tek bir options object / record / DTO içinde grupla.");
            }
        }

        foreach (var ctor in root.DescendantNodes().OfType<ConstructorDeclarationSyntax>())
        {
            if (ctor.ParameterList.Parameters.Count > Threshold)
            {
                yield return new Finding(
                    "Low", "Architecture", filePath, RuleHelpers.LineOf(ctor),
                    Name,
                    $"Constructor {ctor.ParameterList.Parameters.Count} parametre alıyor.",
                    "DI üzerinden çok sayıda bağımlılık alan sınıf çok fazla iş yapıyor olabilir " +
                    "(SRP ihlali).",
                    "Bağımlılıkları gruplayan bir facade tasarla veya sınıfı küçük parçalara böl.");
            }
        }
    }
}

internal sealed class PublicMutableFieldRule : IRule
{
    public string Name => "public-mutable-field";
    public string Category => "Architecture";

    public IEnumerable<Finding> Check(SyntaxTree tree, SemanticModel model, string filePath)
    {
        var root = tree.GetRoot();
        foreach (var field in root.DescendantNodes().OfType<FieldDeclarationSyntax>())
        {
            bool isPublic = field.Modifiers.Any(m => m.Text == "public");
            bool isReadonly = field.Modifiers.Any(m => m.Text == "readonly");
            bool isConst = field.Modifiers.Any(m => m.Text == "const");
            if (isPublic && !isReadonly && !isConst)
            {
                yield return new Finding(
                    "Medium", "Architecture", filePath, RuleHelpers.LineOf(field),
                    Name,
                    "Public mutable field — encapsulation kırılıyor.",
                    "Public field değişimi event/validation tetikleyemez; geriye uyumluluk şartı olmadan " +
                    "property'ye dönüştürülemez, threading anomalilerine açıktır.",
                    "private/protected field + public property (get/init) kullan. " +
                    "Sabitler için const, değişmez referanslar için readonly tercih et.");
            }
        }
    }
}

internal sealed class StaticMutableStateRule : IRule
{
    public string Name => "static-mutable-state";
    public string Category => "Architecture";

    public IEnumerable<Finding> Check(SyntaxTree tree, SemanticModel model, string filePath)
    {
        var root = tree.GetRoot();
        foreach (var field in root.DescendantNodes().OfType<FieldDeclarationSyntax>())
        {
            bool isStatic = field.Modifiers.Any(m => m.Text == "static");
            bool isReadonly = field.Modifiers.Any(m => m.Text == "readonly");
            bool isConst = field.Modifiers.Any(m => m.Text == "const");
            if (isStatic && !isReadonly && !isConst)
            {
                yield return new Finding(
                    "High", "Architecture", filePath, RuleHelpers.LineOf(field),
                    Name,
                    "Static mutable field — process-global state.",
                    "Static mutable state thread-safety, test izolasyonu ve dağıtık deployment'ta " +
                    "ciddi sorunlar yaratır: race condition, gizli sızıntılar, idempotency ihlalleri.",
                    "Bağımlılığı DI üzerinden inject et; durumu scoped/singleton servise taşı. " +
                    "Gerçekten sabitse 'static readonly' yap, atomik gerekiyorsa Interlocked / ImmutableX kullan.");
            }
        }
    }
}

internal static class ArchitectureRules
{
    public static readonly IRule[] All = new IRule[]
    {
        new GodClassRule(),
        new LongMethodRule(),
        new TooManyParamsRule(),
        new PublicMutableFieldRule(),
        new StaticMutableStateRule(),
    };
}
