/**
 * Middleware for adding cross-platform compatibility to the official MCP SDK.
 *
 * Wrap your McpServer to automatically output dual formats for both
 * MCP Apps (Creature) and ChatGPT Apps SDK.
 *
 * @example
 * ```ts
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { wrapServer } from "open-mcp-app/server";
 *
 * const server = wrapServer(new McpServer({ name: "my-app", version: "1.0.0" }));
 *
 * // Use the standard MCP SDK API - dual format is automatic
 * server.registerResource("Panel", "ui://app/panel", { ... }, handler);
 * server.registerTool("search", { ... }, handler);
 * ```
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MIME_TYPES } from "./types.js";

/**
 * Wrap an McpServer to automatically add dual-format support.
 *
 * This intercepts `registerResource` and `registerTool` calls to automatically
 * include both MCP Apps and ChatGPT metadata/MIME types.
 *
 * @param server - An McpServer instance from @modelcontextprotocol/sdk
 * @returns The same server with intercepted registration methods
 *
 * @example
 * ```ts
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { wrapServer } from "open-mcp-app/server";
 *
 * const server = wrapServer(new McpServer({ name: "my-app", version: "1.0.0" }));
 *
 * // Register resources normally - dual MIME types added automatically
 * server.registerResource("Panel", "ui://app/panel", {
 *   mimeType: "text/html",
 *   description: "My panel",
 * }, async () => ({
 *   contents: [{ uri: "ui://app/panel", mimeType: "text/html", text: html }],
 * }));
 *
 * // Register tools normally - dual metadata added automatically
 * server.registerTool("search", {
 *   description: "Search",
 *   inputSchema: z.object({ query: z.string() }),
 *   _meta: {
 *     ui: { resourceUri: "ui://app/panel", displayModes: ["pip"] },
 *     loadingMessage: "Searching...",  // Will become openai/toolInvocation/invoking
 *   },
 * }, handler);
 * ```
 */
export function wrapServer<T extends McpServer>(server: T): T {
  const originalRegisterResource = server.registerResource.bind(server);
  const originalRegisterTool = server.registerTool.bind(server);

  // Intercept registerResource to add dual MIME types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerResource = function (
    name: string,
    uri: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metadata: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (...args: any[]) => any
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrappedHandler = async (...args: any[]) => {
      const result = await handler(...args);

      // Transform contents to include both MIME types
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const transformedContents: any[] = [];

      for (const content of result.contents) {
        // Add MCP Apps version
        const mcpAppsMeta: Record<string, unknown> = {
          ...(content._meta || {}),
          "openai/widgetPrefersBorder": true,
        };

        transformedContents.push({
          ...content,
          mimeType: MIME_TYPES.MCP_APPS,
          _meta: mcpAppsMeta,
        });

        // Add ChatGPT version
        transformedContents.push({
          ...content,
          mimeType: MIME_TYPES.CHATGPT,
          _meta: {
            "openai/widgetPrefersBorder": true,
          },
        });
      }

      return { ...result, contents: transformedContents };
    };

    return originalRegisterResource(
      name,
      uri,
      { ...metadata, mimeType: MIME_TYPES.MCP_APPS },
      wrappedHandler
    );
  };

  // Intercept registerTool to add dual metadata
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = function (
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: any
  ) {
    const meta = config._meta || {};
    const transformedMeta: Record<string, unknown> = { ...meta };

    // If there's MCP Apps ui metadata, also add ChatGPT outputTemplate
    const ui = meta.ui;
    if (ui?.resourceUri) {
      transformedMeta["openai/outputTemplate"] = ui.resourceUri;
    }

    // Map custom keys to ChatGPT format
    if (meta.loadingMessage) {
      transformedMeta["openai/toolInvocation/invoking"] = meta.loadingMessage;
      delete transformedMeta.loadingMessage;
    }
    if (meta.completedMessage) {
      transformedMeta["openai/toolInvocation/invoked"] = meta.completedMessage;
      delete transformedMeta.completedMessage;
    }

    const transformedConfig = {
      ...config,
      ...(Object.keys(transformedMeta).length > 0 && { _meta: transformedMeta }),
    };

    return originalRegisterTool(name, transformedConfig, handler);
  };

  return server;
}
