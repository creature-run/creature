export { createApp, App } from "./app.js";
export { loadHtml, htmlLoader, svgToDataUri, isHtmlContent } from "./utils.js";
export type {
  AppConfig,
  ResourceConfig,
  ToolConfig,
  ToolResult,
  ToolHandler,
  ToolContext,
  InstanceDestroyContext,
  DisplayMode,
  ToolVisibility,
  IconConfig,
  TransportType,
  TransportSessionInfo,
  WebSocketConnection,
} from "./types.js";
export { MIME_TYPES } from "./types.js";

export { wrapServer } from "./middleware.js";

// Experimental APIs
// Access via `exp` namespace for consistent pattern with core SDK (host.exp.*).
export { exp } from "./experimental.js";
export type { KvSearchResult, VectorSearchResult } from "./experimental.js";

// Legacy exports (prefer `exp` namespace above)
export {
  experimental_getWritableDirectory,
  experimental_getProjectId,
  experimental_getServerName,
  experimental_readFile,
  experimental_writeFile,
  experimental_deleteFile,
  experimental_exists,
  experimental_mkdir,
  experimental_readdir,
  experimental_rmdir,
  experimental_readFileSync,
  experimental_writeFileSync,
  experimental_deleteFileSync,
  experimental_existsSync,
  experimental_mkdirSync,
  experimental_readdirSync,
  experimental_rmdirSync,
  experimental_kvIsAvailable,
  experimental_kvGet,
  experimental_kvSet,
  experimental_kvDelete,
  experimental_kvList,
  experimental_kvSearch,
  experimental_vectorIsAvailable,
  experimental_vectorUpsert,
  experimental_vectorSearch,
  experimental_vectorDelete,
  experimental_kvGetSync,
  experimental_kvSetSync,
  experimental_kvDeleteSync,
  experimental_kvListSync,
  experimental_blobIsAvailable,
  experimental_blobPut,
  experimental_blobGet,
  experimental_blobDelete,
  experimental_blobList,
  experimental_blobPutSync,
  experimental_blobGetSync,
  experimental_blobDeleteSync,
  experimental_blobListSync,
  experimental_sampleMessage,
} from "./experimental.js";
