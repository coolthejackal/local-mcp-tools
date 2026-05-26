using Microsoft.CodeAnalysis;

namespace ContextMcp.Roslyn.Review;

internal interface IRule
{
    string Name { get; }
    string Category { get; }
    IEnumerable<Finding> Check(SyntaxTree tree, SemanticModel model, string filePath);
}

internal static class RuleHelpers
{
    public static int LineOf(SyntaxNode node) =>
        node.GetLocation().GetLineSpan().StartLinePosition.Line + 1;

    public static int LineOf(SyntaxToken token) =>
        token.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
}
