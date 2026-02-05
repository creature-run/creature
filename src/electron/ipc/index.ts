/**
 * IPC Module
 *
 * Registers all IPC handlers for the main process.
 */

import { registerAppHandlers } from "./app.handlers";
import { registerAuthHandlers } from "./auth.handlers";
import { registerChatHandlers } from "./chat.handlers";
import { registerDevConsoleHandlers } from "./devconsole.handlers";
import { registerEmbeddingsHandlers } from "./embeddings.handlers";
import { registerFileHandlers } from "./file.handlers";
import { registerImageHandlers } from "./image.handlers";
import { registerMcpHandlers } from "./mcp.handlers";
import { registerPipHandlers } from "./pip.handlers";
import { registerProjectHandlers } from "./project.handlers";
import { registerSamplingHandlers } from "./sampling.handlers";
import { registerSettingsHandlers } from "./settings.handlers";
import { registerWindowHandlers } from "./window.handlers";

/**
 * Register all IPC handlers.
 * Call this once during app initialization.
 */
export const registerAllIpcHandlers = () => {
  registerAppHandlers();
  registerAuthHandlers();
  registerChatHandlers();
  registerDevConsoleHandlers();
  registerEmbeddingsHandlers();
  registerFileHandlers();
  registerImageHandlers();
  registerMcpHandlers();
  registerPipHandlers();
  registerProjectHandlers();
  registerSamplingHandlers();
  registerSettingsHandlers();
  registerWindowHandlers();
};

export * from "./app.handlers";
export * from "./auth.handlers";
export * from "./chat.handlers";
export * from "./devconsole.handlers";
export * from "./embeddings.handlers";
export * from "./file.handlers";
export * from "./image.handlers";
export * from "./mcp.handlers";
export * from "./pip.handlers";
export * from "./project.handlers";
export * from "./sampling.handlers";
export * from "./settings.handlers";
export * from "./window.handlers";
