import ts from "typescript"
import { MCPPlugin } from "./pluginSystem"
import { getProgram } from "../ts/tsIncremental"

export const ReactPlugin: MCPPlugin = {
  name: "react",

  onQuery(query, ctx) {
    const program = getProgram()
    const components: { name: string; file: string }[] = []

    for (const sf of program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue

      ts.forEachChild(sf, node => {
        if (ts.isFunctionDeclaration(node) && node.name) {
          const name = node.name.getText()
          if (name[0] === name[0]?.toUpperCase()) {
            components.push({
              name,
              file: sf.fileName
            })
          }
        }
      })
    }

    return {
      type: "react-components",
      data: components
    }
  }
}