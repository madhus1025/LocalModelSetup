import { createEditorTools } from "./editorTools";
import { createFileTools } from "./fileTools";
import { createGitTools } from "./gitTools";
import { ToolRegistry } from "./registry";
import { createTerminalTool } from "./terminalTool";

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry([
    ...createFileTools(),
    ...createEditorTools(),
    ...createGitTools(),
    createTerminalTool()
  ]);
}
