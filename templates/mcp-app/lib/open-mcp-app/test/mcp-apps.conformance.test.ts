/**
 * MCP Apps Conformance Tests
 *
 * Contract tests validating the SDK's outputs against SEP-1865 (2026-01-26).
 * These tests use the serverless handler to avoid binding ports.
 *
 * Spec reference: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 */

import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { createApp, MIME_TYPES } from "../src/server/index.js";
import type { App } from "../src/server/index.js";

// ============================================================================
// Test Harness
// ============================================================================

/**
 * JSON-RPC request helper that uses the SDK's handleMcpRequest directly.
 * Avoids port binding by calling the method directly on the App instance.
 */
async function jsonRpcRequest(
  app: App,
  method: string,
  params?: Record<string, unknown>
): Promise<{
  jsonrpc: string;
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}> {
  return app.handleMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });
}

// ============================================================================
// Test Fixtures
// ============================================================================

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Test</title></head>
<body><div id="app"></div></body>
</html>`;

const RESOURCE_URI = "ui://test-app/panel";
const RESOURCE_URI_WITH_CSP = "ui://test-app/panel-csp";
const RESOURCE_URI_MULTI_INSTANCE = "ui://test-app/multi-instance";

/**
 * Create a test app with resources and tools configured for conformance testing.
 */
function createTestApp() {
  const app = createApp({
    name: "conformance-test",
    version: "1.0.0",
  });

  // Basic resource without CSP
  app.resource({
    name: "Test Panel",
    uri: RESOURCE_URI,
    description: "A test UI panel",
    displayModes: ["inline", "pip"],
    html: FIXTURE_HTML,
  });

  // Resource with CSP configuration
  app.resource({
    name: "Test Panel CSP",
    uri: RESOURCE_URI_WITH_CSP,
    description: "A test UI panel with CSP",
    displayModes: ["inline"],
    html: FIXTURE_HTML,
    csp: {
      connectDomains: ["https://api.example.com"],
      resourceDomains: ["https://cdn.example.com"],
    },
  });

  // Resource with instanceMode multiple (views-based routing)
  app.resource({
    name: "Multi-Instance Panel",
    uri: RESOURCE_URI_MULTI_INSTANCE,
    description: "A test UI panel with multi-instance support",
    displayModes: ["pip"],
    html: FIXTURE_HTML,
    instanceMode: "multiple",
  });

  // Tool with UI linkage (default visibility)
  app.tool(
    "show_panel",
    {
      description: "Show the test panel",
      ui: RESOURCE_URI,
      input: z.object({
        title: z.string().optional(),
      }),
    },
    async (input) => ({
      data: { title: input.title || "Default" },
      text: "Panel shown",
    })
  );

  // Tool with explicit visibility (model + app)
  app.tool(
    "update_panel",
    {
      description: "Update the panel",
      ui: RESOURCE_URI,
      visibility: ["model", "app"],
      input: z.object({
        content: z.string(),
      }),
    },
    async (input) => ({
      data: { content: input.content },
      text: "Panel updated",
    })
  );

  // App-only tool (hidden from model)
  app.tool(
    "refresh_panel",
    {
      description: "Refresh panel data",
      ui: RESOURCE_URI,
      visibility: ["app"],
      input: z.object({}),
    },
    async () => ({
      data: { refreshed: true },
      text: "Panel refreshed",
    })
  );

  // Tool without UI (text-only)
  app.tool(
    "get_status",
    {
      description: "Get app status",
      input: z.object({}),
    },
    async () => ({
      text: "Status: OK",
    })
  );

  // Tool with experimental defaultDisplayMode
  app.tool(
    "show_multi_instance",
    {
      description: "Show multi-instance panel",
      ui: RESOURCE_URI_MULTI_INSTANCE,
      displayModes: ["pip", "inline"],
      experimental: {
        defaultDisplayMode: "pip",
      },
      input: z.object({}),
    },
    async () => ({
      data: { created: true },
      text: "Multi-instance panel created",
    })
  );

  return app;
}

// ============================================================================
// Resource Conformance Tests (SEP-1865)
// ============================================================================

describe("MCP Apps Resource Conformance (SEP-1865)", () => {
  let app: App;

  beforeAll(async () => {
    app = createTestApp();
    // Initialize to set up server state
    await jsonRpcRequest(app, "initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "conformance-test", version: "1.0.0" },
      capabilities: {},
    });
  });

  describe("resources/list", () => {
    it("returns resources with ui:// URI scheme", async () => {
      const response = await jsonRpcRequest(app, "resources/list");

      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();

      const result = response.result as { resources: Array<{ uri: string }> };
      expect(result.resources).toBeInstanceOf(Array);
      expect(result.resources.length).toBeGreaterThan(0);

      // SEP-1865: Resource URIs MUST use ui:// scheme
      for (const resource of result.resources) {
        expect(resource.uri).toMatch(/^ui:\/\//);
      }
    });

    it("returns resources with correct mimeType", async () => {
      const response = await jsonRpcRequest(app, "resources/list");
      const result = response.result as {
        resources: Array<{ uri: string; mimeType: string }>;
      };

      // SEP-1865: mimeType MUST be text/html;profile=mcp-app
      for (const resource of result.resources) {
        expect(resource.mimeType).toBe(MIME_TYPES.MCP_APPS);
      }
    });

    it("returns resources with required name field", async () => {
      const response = await jsonRpcRequest(app, "resources/list");
      const result = response.result as {
        resources: Array<{ uri: string; name: string }>;
      };

      // SEP-1865: name is required
      for (const resource of result.resources) {
        expect(resource.name).toBeDefined();
        expect(typeof resource.name).toBe("string");
        expect(resource.name.length).toBeGreaterThan(0);
      }
    });
  });

  describe("resources/read", () => {
    it("returns contents with correct mimeType for ui:// resources", async () => {
      const response = await jsonRpcRequest(app, "resources/read", {
        uri: RESOURCE_URI,
      });

      expect(response.error).toBeUndefined();
      const result = response.result as {
        contents: Array<{ uri: string; mimeType: string; text?: string }>;
      };

      expect(result.contents).toBeInstanceOf(Array);
      expect(result.contents.length).toBeGreaterThan(0);

      const content = result.contents[0];
      // SEP-1865: mimeType MUST be text/html;profile=mcp-app
      expect(content.mimeType).toBe(MIME_TYPES.MCP_APPS);
      expect(content.uri).toBe(RESOURCE_URI);
    });

    it("returns HTML content via text field", async () => {
      const response = await jsonRpcRequest(app, "resources/read", {
        uri: RESOURCE_URI,
      });

      const result = response.result as {
        contents: Array<{ text?: string; blob?: string }>;
      };
      const content = result.contents[0];

      // SEP-1865: Content MUST be provided via either text (string) or blob (base64)
      expect(content.text || content.blob).toBeDefined();

      if (content.text) {
        // SEP-1865: Content MUST be valid HTML5 document
        expect(content.text).toContain("<!DOCTYPE html>");
        expect(content.text).toContain("<html");
      }
    });

    it("includes CSP metadata when configured", async () => {
      const response = await jsonRpcRequest(app, "resources/read", {
        uri: RESOURCE_URI_WITH_CSP,
      });

      const result = response.result as {
        contents: Array<{
          _meta?: {
            ui?: {
              csp?: {
                connectDomains?: string[];
                resourceDomains?: string[];
              };
            };
          };
        }>;
      };

      const content = result.contents[0];
      // SEP-1865: _meta.ui.csp should reflect server-declared domains
      expect(content._meta?.ui?.csp).toBeDefined();
      expect(content._meta?.ui?.csp?.connectDomains).toContain(
        "https://api.example.com"
      );
      expect(content._meta?.ui?.csp?.resourceDomains).toContain(
        "https://cdn.example.com"
      );
    });

    it("returns matching uri in contents", async () => {
      const response = await jsonRpcRequest(app, "resources/read", {
        uri: RESOURCE_URI,
      });

      const result = response.result as {
        contents: Array<{ uri: string }>;
      };

      // SEP-1865: uri in contents MUST match the requested resource
      expect(result.contents[0].uri).toBe(RESOURCE_URI);
    });
  });
});

// ============================================================================
// Tool Conformance Tests (SEP-1865)
// ============================================================================

describe("MCP Apps Tool Conformance (SEP-1865)", () => {
  let app: App;

  beforeAll(async () => {
    app = createTestApp();
    await jsonRpcRequest(app, "initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "conformance-test", version: "1.0.0" },
      capabilities: {},
    });
  });

  describe("tools/list - UI linkage", () => {
    it("includes _meta.ui.resourceUri for tools with UI", async () => {
      const response = await jsonRpcRequest(app, "tools/list");

      expect(response.error).toBeUndefined();
      const result = response.result as {
        tools: Array<{
          name: string;
          _meta?: { ui?: { resourceUri?: string } };
        }>;
      };

      const showPanelTool = result.tools.find((t) => t.name === "show_panel");
      expect(showPanelTool).toBeDefined();

      // SEP-1865: Tools reference UI resources via _meta.ui.resourceUri
      expect(showPanelTool?._meta?.ui?.resourceUri).toBe(RESOURCE_URI);
    });

    it("resourceUri references a ui:// resource", async () => {
      const response = await jsonRpcRequest(app, "tools/list");
      const result = response.result as {
        tools: Array<{
          name: string;
          _meta?: { ui?: { resourceUri?: string } };
        }>;
      };

      // SEP-1865: resourceUri MUST reference a ui:// resource
      for (const tool of result.tools) {
        if (tool._meta?.ui?.resourceUri) {
          expect(tool._meta.ui.resourceUri).toMatch(/^ui:\/\//);
        }
      }
    });

    it("does not include _meta.ui for tools without UI", async () => {
      const response = await jsonRpcRequest(app, "tools/list");
      const result = response.result as {
        tools: Array<{
          name: string;
          _meta?: { ui?: { resourceUri?: string } };
        }>;
      };

      const statusTool = result.tools.find((t) => t.name === "get_status");
      expect(statusTool).toBeDefined();

      // Tools without UI should not have ui.resourceUri
      expect(statusTool?._meta?.ui?.resourceUri).toBeUndefined();
    });
  });

  describe("tools/list - visibility", () => {
    it("defaults visibility to ['model', 'app'] when not specified", async () => {
      const response = await jsonRpcRequest(app, "tools/list");
      const result = response.result as {
        tools: Array<{
          name: string;
          _meta?: { ui?: { visibility?: string[] } };
        }>;
      };

      const showPanelTool = result.tools.find((t) => t.name === "show_panel");

      // SEP-1865: visibility defaults to ["model", "app"] if omitted
      expect(showPanelTool?._meta?.ui?.visibility).toEqual(["model", "app"]);
    });

    it("respects explicit visibility configuration", async () => {
      const response = await jsonRpcRequest(app, "tools/list");
      const result = response.result as {
        tools: Array<{
          name: string;
          _meta?: { ui?: { visibility?: string[] } };
        }>;
      };

      const updateTool = result.tools.find((t) => t.name === "update_panel");
      expect(updateTool?._meta?.ui?.visibility).toEqual(["model", "app"]);

      const refreshTool = result.tools.find((t) => t.name === "refresh_panel");
      expect(refreshTool?._meta?.ui?.visibility).toEqual(["app"]);
    });

    it("includes required tool fields (name, description, inputSchema)", async () => {
      const response = await jsonRpcRequest(app, "tools/list");
      const result = response.result as {
        tools: Array<{
          name: string;
          description: string;
          inputSchema: unknown;
        }>;
      };

      for (const tool of result.tools) {
        expect(tool.name).toBeDefined();
        expect(typeof tool.name).toBe("string");
        expect(tool.description).toBeDefined();
        expect(typeof tool.description).toBe("string");
        expect(tool.inputSchema).toBeDefined();
      }
    });
  });

  describe("tools/call - result format", () => {
    it("returns content array with text items", async () => {
      const response = await jsonRpcRequest(app, "tools/call", {
        name: "show_panel",
        arguments: { title: "Test Title" },
      });

      expect(response.error).toBeUndefined();
      const result = response.result as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content).toBeInstanceOf(Array);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe("text");
      expect(typeof result.content[0].text).toBe("string");
    });

    it("returns structuredContent for UI rendering", async () => {
      const response = await jsonRpcRequest(app, "tools/call", {
        name: "show_panel",
        arguments: { title: "Test Title" },
      });

      const result = response.result as {
        structuredContent?: Record<string, unknown>;
      };

      // SEP-1865: structuredContent is for UI rendering (not model context)
      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent?.title).toBe("Test Title");
    });

    it("includes instanceId in structuredContent for tools with UI", async () => {
      const response = await jsonRpcRequest(app, "tools/call", {
        name: "show_panel",
        arguments: {},
      });

      const result = response.result as {
        structuredContent?: { instanceId?: string };
      };

      // SDK provides instanceId for widget instance tracking
      expect(result.structuredContent?.instanceId).toBeDefined();
      expect(typeof result.structuredContent?.instanceId).toBe("string");
    });
  });
});

// ============================================================================
// Experimental Namespace Tests (Non-Standard Extensions)
// ============================================================================

describe("Experimental Namespace (Non-Standard Extensions)", () => {
  let app: App;

  beforeAll(async () => {
    app = createTestApp();
    await jsonRpcRequest(app, "initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "conformance-test", version: "1.0.0" },
      capabilities: {},
    });
  });

  describe("resources/list - instanceMode", () => {
    it("includes instanceMode in _meta.ui for multi-instance resources", async () => {
      const response = await jsonRpcRequest(app, "resources/list");
      const result = response.result as {
        resources: Array<{
          uri: string;
          _meta?: { ui?: { instanceMode?: string } };
        }>;
      };

      const multiInstanceResource = result.resources.find(
        (r) => r.uri === RESOURCE_URI_MULTI_INSTANCE
      );
      expect(multiInstanceResource).toBeDefined();

      expect(multiInstanceResource?._meta?.ui?.instanceMode).toBe("multiple");
    });

    it("does not include instanceMode for resources without it", async () => {
      const response = await jsonRpcRequest(app, "resources/list");
      const result = response.result as {
        resources: Array<{
          uri: string;
          _meta?: { ui?: { instanceMode?: string } };
        }>;
      };

      const basicResource = result.resources.find(
        (r) => r.uri === RESOURCE_URI
      );
      expect(basicResource).toBeDefined();

      expect(basicResource?._meta?.ui?.instanceMode).toBeUndefined();
    });
  });

  describe("tools/list - experimental.defaultDisplayMode", () => {
    it("includes experimental.defaultDisplayMode in _meta.ui for tools with defaultDisplayMode", async () => {
      const response = await jsonRpcRequest(app, "tools/list");
      const result = response.result as {
        tools: Array<{
          name: string;
          _meta?: { ui?: { experimental?: { defaultDisplayMode?: string } } };
        }>;
      };

      const multiInstanceTool = result.tools.find(
        (t) => t.name === "show_multi_instance"
      );
      expect(multiInstanceTool).toBeDefined();

      // Non-standard: defaultDisplayMode is under experimental namespace
      expect(multiInstanceTool?._meta?.ui?.experimental?.defaultDisplayMode).toBe("pip");
    });

    it("does not include experimental for tools without experimental config", async () => {
      const response = await jsonRpcRequest(app, "tools/list");
      const result = response.result as {
        tools: Array<{
          name: string;
          _meta?: { ui?: { experimental?: { defaultDisplayMode?: string } } };
        }>;
      };

      const showPanelTool = result.tools.find((t) => t.name === "show_panel");
      expect(showPanelTool).toBeDefined();

      // Tools without experimental config should not have experimental field
      expect(showPanelTool?._meta?.ui?.experimental).toBeUndefined();
    });
  });
});

// ============================================================================
// Spec Backlog (SEP-1865 features not yet fully surfaced by SDK)
// ============================================================================

describe("MCP Apps Spec Backlog (SEP-1865)", () => {
  it.todo(
    "resources/read should support _meta.ui.permissions (camera, microphone, geolocation, clipboardWrite)"
  );

  it.todo(
    "resources/read should support _meta.ui.prefersBorder boolean"
  );

  it.todo(
    "resources/read should support _meta.ui.csp.frameDomains for nested iframes"
  );

  it.todo(
    "resources/read should support _meta.ui.csp.baseUriDomains for base URI restrictions"
  );

  it.todo(
    "resources/read should support _meta.ui.domain for dedicated sandbox origin"
  );

  it.todo(
    "tools/list should filter out app-only tools when visibility does not include 'model'"
  );
});

// ============================================================================
// Protocol Version Conformance
// ============================================================================

describe("MCP Protocol Conformance", () => {
  let app: App;

  beforeAll(() => {
    app = createTestApp();
  });

  it("initialize returns protocolVersion and serverInfo", async () => {
    const response = await jsonRpcRequest(app, "initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "test", version: "1.0.0" },
      capabilities: {},
    });

    expect(response.error).toBeUndefined();
    const result = response.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      capabilities: unknown;
    };

    expect(result.protocolVersion).toBeDefined();
    expect(result.serverInfo).toBeDefined();
    expect(result.serverInfo.name).toBe("conformance-test");
    expect(result.serverInfo.version).toBe("1.0.0");
    expect(result.capabilities).toBeDefined();
  });

  it("returns JSON-RPC 2.0 responses", async () => {
    const response = await jsonRpcRequest(app, "initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "test", version: "1.0.0" },
      capabilities: {},
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
  });

  it("returns error for unknown methods", async () => {
    const response = await jsonRpcRequest(app, "unknown/method");

    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(-32601); // Method not found
  });
});
