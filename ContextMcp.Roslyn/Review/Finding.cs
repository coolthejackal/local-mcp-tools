namespace ContextMcp.Roslyn.Review;

// JSON şekli TypeScript tarafındaki Finding ile birebir uyumlu.
// camelCase serileştirme JsonSerializerOptions.PropertyNamingPolicy ile sağlanır.

internal sealed record Finding(
    string Severity,        // "Critical" | "High" | "Medium" | "Low" | "Suggestion"
    string Category,        // "Security" | "Architecture" | "Performance" | "ErrorHandling"
    string File,
    int Line,
    string Rule,
    string Message,
    string Impact,
    string Recommendation);
