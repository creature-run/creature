/**
 * Browser Module
 *
 * Provides Host-side browser automation using Electron's native webview.
 * This is a special capability for the mcp-browser MCP server only.
 */

export {
  createInstance,
  getInstance,
  updateInstanceState,
  executeCommand,
  closeInstance,
  listInstances,
  closeAllInstances,
  setMainWindow,
  type BrowserInstance,
  type BrowserState,
  type BrowserCommand,
} from "./webviewManager";
