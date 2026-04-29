export function summarizeCode(content: string, maxLines: number = 50) {
  if (!content) return ""

  const lines = content.split("\n")
  const important: string[] = []

  for (const line of lines) {
    const l = line.trim()

    if (
      l.startsWith("export") ||
      l.startsWith("function") ||
      l.startsWith("class") ||
      l.includes("return") ||
      l.startsWith("if") ||
      l.startsWith("const") ||
      l.startsWith("let")
    ) {
      important.push(line)
    }

    if (important.length >= maxLines) break
  }

  if (important.length === 0) {
    return lines.slice(0, maxLines).join("\n")
  }

  return important.join("\n")
}