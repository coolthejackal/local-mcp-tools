import ts from "typescript"
import { MCPPlugin } from "./pluginSystem"
import { getProgram } from "../ts/tsIncremental"

export const DevExtremePlugin: MCPPlugin = {
  name: "devextreme",

  onQuery(_, ctx) {
    const program = getProgram()
    const results: { file: string; component: string }[] = []

    for (const sf of program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue

      function visit(node: ts.Node) {
        if (ts.isJsxOpeningElement(node)) {
          const tag = node.tagName.getText()

          if (
            tag.includes("Grid") ||
            tag.includes("Form") ||
            tag.includes("DataGrid")
          ) {
            results.push({
              file: sf.fileName,
              component: tag
            })
          }
        }

        ts.forEachChild(node, visit)
      }

      visit(sf)
    }

    return {
      type: "devextreme-components",
      data: results
    }
  }
}