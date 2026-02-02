/**
 * Control Plane Routing Tests
 *
 * Tests the view-based pip routing logic without Electron dependencies.
 * Validates message payloads for all routing scenarios documented in routing.ts.
 *
 * Instance Modes:
 * - "single" (default): One pip per resource, reuses existing pip
 * - "multiple": View-based routing
 *
 * Routing scenarios (instanceMode: "multiple"):
 * 1. Explicit _instanceId in args → route to that pip directly (always honored)
 * 2. Root view "/" → single instance, reuse if exists
 * 3. Parameterized view "/path/:param" → one instance per unique param value
 * 4. Static view "/path" → always create new instance (for create tools)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  extractParamNames,
  getViewForTool,
  findPipByParams,
  findRootPip,
  findAnyPipForResource,
  resolveInstanceIdForTool,
  type Views,
  type RoutablePipInstance,
  type ResourceMetadata,
} from "../src/electron/mcp/routing";

// ============================================================================
// Test Harness
// ============================================================================

interface TestHarness {
  pipInstances: Map<string, RoutablePipInstance>;
  resourceMetadata: Map<string, ResourceMetadata>;

  // Test helpers
  createPip: (params: {
    instanceId: string;
    resourceUri: string;
    serverName: string;
    widgetState?: { modelContent?: Record<string, unknown> | string };
  }) => RoutablePipInstance;
  setResourceMetadata: (serverName: string, uri: string, metadata: ResourceMetadata) => void;
  getResourceMetadata: (serverName: string, uri: string) => ResourceMetadata | undefined;
}

const createTestHarness = (): TestHarness => {
  const pipInstances = new Map<string, RoutablePipInstance>();
  const resourceMetadata = new Map<string, ResourceMetadata>();

  return {
    pipInstances,
    resourceMetadata,

    createPip: ({ instanceId, resourceUri, serverName, widgetState }) => {
      const pip: RoutablePipInstance = {
        instanceId,
        resourceUri,
        serverName,
        widgetState,
      };
      pipInstances.set(instanceId, pip);
      return pip;
    },

    setResourceMetadata: (serverName: string, uri: string, metadata: ResourceMetadata) => {
      resourceMetadata.set(`${serverName}:${uri}`, metadata);
    },

    getResourceMetadata: (serverName: string, uri: string) => {
      return resourceMetadata.get(`${serverName}:${uri}`);
    },
  };
};

// ============================================================================
// Tests
// ============================================================================

describe("Control Plane Routing", () => {
  let harness: TestHarness;

  const SERVER_NAME = "test-mcp";
  const RESOURCE_URI = "ui://test-mcp/app";

  beforeEach(() => {
    harness = createTestHarness();
  });

  const resolve = (toolName: string, args: Record<string, unknown>, resourceUri = RESOURCE_URI) => {
    return resolveInstanceIdForTool({
      pipInstances: harness.pipInstances.values(),
      getPipById: (id) => harness.pipInstances.get(id),
      resourceMetadata: harness.getResourceMetadata(SERVER_NAME, resourceUri),
      serverName: SERVER_NAME,
      toolName,
      args,
      resourceUri,
    });
  };

  describe("Scenario 1: Explicit _instanceId in args", () => {
    it("routes to existing pip when _instanceId matches", () => {
      const existingPip = harness.createPip({
        instanceId: "inst_existing_123",
        resourceUri: RESOURCE_URI,
        serverName: SERVER_NAME,
      });

      const result = resolve("any_tool", { _instanceId: "inst_existing_123" });

      expect(result.instanceId).toBe("inst_existing_123");
      expect(result.existingPip).toBe(existingPip);
      expect(result.isReusingPip).toBe(true);
    });

    it("creates new pip with provided _instanceId when not found", () => {
      const result = resolve("any_tool", { _instanceId: "inst_new_456" });

      expect(result.instanceId).toBe("inst_new_456");
      expect(result.existingPip).toBeUndefined();
      expect(result.isReusingPip).toBe(false);
    });

    it("ignores views config when explicit _instanceId is provided", () => {
      harness.setResourceMetadata(SERVER_NAME, RESOURCE_URI, {
        uri: RESOURCE_URI,
        name: "Test App",
        views: { "/": ["root_tool"] },
      });

      const existingPip = harness.createPip({
        instanceId: "inst_specific",
        resourceUri: RESOURCE_URI,
        serverName: SERVER_NAME,
        widgetState: { modelContent: { noteId: "note_1" } },
      });

      const result = resolve("root_tool", { _instanceId: "inst_specific" });

      expect(result.instanceId).toBe("inst_specific");
      expect(result.existingPip).toBe(existingPip);
      expect(result.isReusingPip).toBe(true);
    });
  });

  describe("Scenario 2: instanceMode 'single' (default)", () => {
    it("creates new pip on first call", () => {
      harness.setResourceMetadata(SERVER_NAME, RESOURCE_URI, {
        uri: RESOURCE_URI,
        name: "Test App",
        // instanceMode defaults to "single"
      });

      const result = resolve("any_tool", {});

      expect(result.instanceId).toMatch(/^inst_/);
      expect(result.existingPip).toBeUndefined();
      expect(result.isReusingPip).toBe(false);
      expect(result.error).toBeUndefined();
    });

    it("reuses existing pip regardless of tool or args", () => {
      harness.setResourceMetadata(SERVER_NAME, RESOURCE_URI, {
        uri: RESOURCE_URI,
        name: "Test App",
        // instanceMode defaults to "single"
      });

      const existingPip = harness.createPip({
        instanceId: "inst_single",
        resourceUri: RESOURCE_URI,
        serverName: SERVER_NAME,
        widgetState: { modelContent: { noteId: "note_1" } },
      });

      // Different tool, different args → still reuses same pip
      const result = resolve("different_tool", { someArg: "value" });

      expect(result.instanceId).toBe("inst_single");
      expect(result.existingPip).toBe(existingPip);
      expect(result.isReusingPip).toBe(true);
    });

    it("works without views config", () => {
      harness.setResourceMetadata(SERVER_NAME, RESOURCE_URI, {
        uri: RESOURCE_URI,
        name: "Test App",
        // No views, no instanceMode (defaults to "single")
      });

      const existingPip = harness.createPip({
        instanceId: "inst_existing",
        resourceUri: RESOURCE_URI,
        serverName: SERVER_NAME,
      });

      const result = resolve("any_tool", {});

      expect(result.instanceId).toBe("inst_existing");
      expect(result.existingPip).toBe(existingPip);
      expect(result.isReusingPip).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe("Scenario 3: Tool not in any view (instanceMode: multiple)", () => {
    beforeEach(() => {
      harness.setResourceMetadata(SERVER_NAME, RESOURCE_URI, {
        uri: RESOURCE_URI,
        name: "Test App",
        instanceMode: "multiple",
        // No views config
      });
    });

    it("returns error when no views config exists", () => {
      const result = resolve("any_tool", {});

      expect(result.error).toContain("any_tool");
      expect(result.error).toContain("not in any view");
      expect(result.instanceId).toBeUndefined();
      expect(result.viewPath).toBeUndefined();
      expect(result.isReusingPip).toBe(false);
    });

    it("returns error even when existing pips exist", () => {
      harness.createPip({
        instanceId: "inst_old",
        resourceUri: RESOURCE_URI,
        serverName: SERVER_NAME,
      });

      const result = resolve("any_tool", {});

      expect(result.error).toBeDefined();
      expect(result.instanceId).toBeUndefined();
      expect(result.existingPip).toBeUndefined();
    });
  });

  describe("Scenario 4: Root view '/' (instanceMode: multiple)", () => {
    beforeEach(() => {
      harness.setResourceMetadata(SERVER_NAME, RESOURCE_URI, {
        uri: RESOURCE_URI,
        name: "Test App",
        instanceMode: "multiple",
        views: {
          "/": ["list_items", "refresh_items"],
        },
      });
    });

    it("creates new pip on first call", () => {
      const result = resolve("list_items", {});

      expect(result.instanceId).toMatch(/^inst_/);
      expect(result.existingPip).toBeUndefined();
      expect(result.viewPath).toBe("/");
      expect(result.isReusingPip).toBe(false);
    });

    it("reuses existing root pip on subsequent calls", () => {
      const existingPip = harness.createPip({
        instanceId: "inst_root_pip",
        resourceUri: RESOURCE_URI,
        serverName: SERVER_NAME,
        widgetState: { modelContent: {} },
      });

      const result = resolve("refresh_items", {});

      expect(result.instanceId).toBe("inst_root_pip");
      expect(result.existingPip).toBe(existingPip);
      expect(result.viewPath).toBe("/");
      expect(result.isReusingPip).toBe(true);
    });

    it("reuses root pip with view='/' in modelContent", () => {
      const existingPip = harness.createPip({
        instanceId: "inst_root_explicit",
        resourceUri: RESOURCE_URI,
        serverName: SERVER_NAME,
        widgetState: { modelContent: { view: "/" } },
      });

      const result = resolve("list_items", {});

      expect(result.instanceId).toBe("inst_root_explicit");
      expect(result.existingPip).toBe(existingPip);
      expect(result.isReusingPip).toBe(true);
    });

    it("does not reuse pip with non-empty modelContent params", () => {
      harness.createPip({
        instanceId: "inst_with_params",
        resourceUri: RESOURCE_URI,
        serverName: SERVER_NAME,
        widgetState: { modelContent: { noteId: "note_123" } },
      });

      const result = resolve("list_items", {});

      expect(result.instanceId).not.toBe("inst_with_params");
      expect(result.existingPip).toBeUndefined();
      expect(result.isReusingPip).toBe(false);
    });
  });

  describe("Scenario 5: Parameterized view '/path/:param' (instanceMode: multiple)", () => {
    beforeEach(() => {
      harness.setResourceMetadata(SERVER_NAME, RESOURCE_URI, {
        uri: RESOURCE_URI,
        name: "Notes App",
        instanceMode: "multiple",
        views: {
          "/": ["notes_list"],
          "/editor/:noteId": ["notes_open", "notes_save", "notes_delete"],
        },
      });
    });

    it("creates new pip when param is provided but no matching pip exists", () => {
      const result = resolve("notes_open", { noteId: "note_123" });

      expect(result.instanceId).toMatch(/^inst_/);
      expect(result.existingPip).toBeUndefined();
      expect(result.viewPath).toBe("/editor/:noteId");
      expect(result.isReusingPip).toBe(false);
    });

    it("reuses pip when param matches widgetState.modelContent", () => {
      const existingPip = harness.createPip({
        instanceId: "inst_note_123",
        resourceUri: RESOURCE_URI,
        serverName: SERVER_NAME,
        widgetState: { modelContent: { noteId: "note_123" } },
      });

      const result = resolve("notes_save", { noteId: "note_123", content: "Updated content" });

      expect(result.instanceId).toBe("inst_note_123");
      expect(result.existingPip).toBe(existingPip);
      expect(result.viewPath).toBe("/editor/:noteId");
      expect(result.isReusingPip).toBe(true);
    });

    it("creates separate pips for different param values", () => {
      harness.createPip({
        instanceId: "inst_note_1",
        resourceUri: RESOURCE_URI,
        serverName: SERVER_NAME,
        widgetState: { modelContent: { noteId: "note_1" } },
      });

      const result = resolve("notes_open", { noteId: "note_2" });

      expect(result.instanceId).not.toBe("inst_note_1");
      expect(result.existingPip).toBeUndefined();
      expect(result.isReusingPip).toBe(false);
    });

    it("creates new pip when param is not in args", () => {
      harness.createPip({
        instanceId: "inst_note_existing",
        resourceUri: RESOURCE_URI,
        serverName: SERVER_NAME,
        widgetState: { modelContent: { noteId: "note_existing" } },
      });

      const result = resolve("notes_open", {}); // No noteId provided

      expect(result.instanceId).not.toBe("inst_note_existing");
      expect(result.existingPip).toBeUndefined();
      expect(result.isReusingPip).toBe(false);
    });

    it("handles multiple params correctly", () => {
      harness.setResourceMetadata(SERVER_NAME, RESOURCE_URI, {
        uri: RESOURCE_URI,
        name: "File Browser",
        instanceMode: "multiple",
        views: {
          "/folder/:folderId/file/:fileId": ["open_file", "save_file"],
        },
      });

      const existingPip = harness.createPip({
        instanceId: "inst_folder_file",
        resourceUri: RESOURCE_URI,
        serverName: SERVER_NAME,
        widgetState: { modelContent: { folderId: "folder_1", fileId: "file_a" } },
      });

      // Same folder and file → reuse
      const result1 = resolve("save_file", { folderId: "folder_1", fileId: "file_a" });

      expect(result1.existingPip).toBe(existingPip);
      expect(result1.isReusingPip).toBe(true);

      // Different file in same folder → new pip
      const result2 = resolve("open_file", { folderId: "folder_1", fileId: "file_b" });

      expect(result2.existingPip).toBeUndefined();
      expect(result2.isReusingPip).toBe(false);
    });
  });

  describe("Cross-scenario: Tool not in any view (instanceMode: multiple)", () => {
    beforeEach(() => {
      harness.setResourceMetadata(SERVER_NAME, RESOURCE_URI, {
        uri: RESOURCE_URI,
        name: "Notes App",
        instanceMode: "multiple",
        views: {
          "/": ["notes_list"],
          "/editor/:noteId": ["notes_open"],
        },
      });
    });

    it("returns error for tool not listed in views", () => {
      const result = resolve("notes_export", {}); // Not in any view

      expect(result.error).toContain("notes_export");
      expect(result.instanceId).toBeUndefined();
      expect(result.viewPath).toBeUndefined();
      expect(result.existingPip).toBeUndefined();
      expect(result.isReusingPip).toBe(false);
    });
  })

  describe("Scenario 6: Static view '/path' (instanceMode: multiple)", () => {
    beforeEach(() => {
      harness.setResourceMetadata(SERVER_NAME, RESOURCE_URI, {
        uri: RESOURCE_URI,
        name: "Notes App",
        instanceMode: "multiple",
        views: {
          "/": ["notes_list"],
          "/editor": ["notes_create"], // Static view - always creates new
          "/editor/:noteId": ["notes_open"],
        },
      });
    });

    it("creates new pip for tool in static view", () => {
      const result = resolve("notes_create", {});

      expect(result.instanceId).toMatch(/^inst_/);
      expect(result.viewPath).toBe("/editor");
      expect(result.existingPip).toBeUndefined();
      expect(result.isReusingPip).toBe(false);
      expect(result.error).toBeUndefined();
    });

    it("always creates new pip even when other pips exist", () => {
      harness.createPip({
        instanceId: "inst_existing",
        resourceUri: RESOURCE_URI,
        serverName: SERVER_NAME,
        widgetState: { modelContent: {} },
      });

      const result1 = resolve("notes_create", {});
      const result2 = resolve("notes_create", {});

      expect(result1.instanceId).toMatch(/^inst_/);
      expect(result2.instanceId).toMatch(/^inst_/);
      expect(result1.instanceId).not.toBe(result2.instanceId);
      expect(result1.isReusingPip).toBe(false);
      expect(result2.isReusingPip).toBe(false);
    });
  });

  describe("Cross-scenario: Different servers/resources", () => {
    it("does not reuse pip from different server", () => {
      harness.setResourceMetadata("server-a", "ui://server-a/app", {
        uri: "ui://server-a/app",
        name: "App A",
        views: { "/": ["tool_a"] },
      });

      harness.setResourceMetadata("server-b", "ui://server-b/app", {
        uri: "ui://server-b/app",
        name: "App B",
        views: { "/": ["tool_b"] },
      });

      harness.createPip({
        instanceId: "inst_server_a",
        resourceUri: "ui://server-a/app",
        serverName: "server-a",
        widgetState: { modelContent: {} },
      });

      const result = resolveInstanceIdForTool({
        pipInstances: harness.pipInstances.values(),
        getPipById: (id) => harness.pipInstances.get(id),
        resourceMetadata: harness.getResourceMetadata("server-b", "ui://server-b/app"),
        serverName: "server-b",
        toolName: "tool_b",
        args: {},
        resourceUri: "ui://server-b/app",
      });

      expect(result.instanceId).not.toBe("inst_server_a");
      expect(result.existingPip).toBeUndefined();
    });

    it("does not reuse pip from different resource on same server", () => {
      harness.setResourceMetadata(SERVER_NAME, "ui://test-mcp/app1", {
        uri: "ui://test-mcp/app1",
        name: "App 1",
        views: { "/": ["tool_1"] },
      });

      harness.setResourceMetadata(SERVER_NAME, "ui://test-mcp/app2", {
        uri: "ui://test-mcp/app2",
        name: "App 2",
        views: { "/": ["tool_2"] },
      });

      harness.createPip({
        instanceId: "inst_app1",
        resourceUri: "ui://test-mcp/app1",
        serverName: SERVER_NAME,
        widgetState: { modelContent: {} },
      });

      const result = resolveInstanceIdForTool({
        pipInstances: harness.pipInstances.values(),
        getPipById: (id) => harness.pipInstances.get(id),
        resourceMetadata: harness.getResourceMetadata(SERVER_NAME, "ui://test-mcp/app2"),
        serverName: SERVER_NAME,
        toolName: "tool_2",
        args: {},
        resourceUri: "ui://test-mcp/app2",
      });

      expect(result.instanceId).not.toBe("inst_app1");
      expect(result.existingPip).toBeUndefined();
    });
  });
});

describe("View Parsing", () => {
  describe("extractParamNames", () => {
    it("extracts single param", () => {
      expect(extractParamNames("/editor/:noteId")).toEqual(["noteId"]);
    });

    it("extracts multiple params", () => {
      expect(extractParamNames("/folder/:folderId/file/:fileId")).toEqual(["folderId", "fileId"]);
    });

    it("returns empty array for root path", () => {
      expect(extractParamNames("/")).toEqual([]);
    });

    it("returns empty array for static path", () => {
      expect(extractParamNames("/editor")).toEqual([]);
    });

    it("handles underscores in param names", () => {
      expect(extractParamNames("/item/:item_id")).toEqual(["item_id"]);
    });
  });

  describe("getViewForTool", () => {
    const views: Views = {
      "/": ["list_items"],
      "/editor": ["create_item"],
      "/editor/:itemId": ["open_item", "save_item"],
    };

    it("finds root view for tool", () => {
      const result = getViewForTool({ toolName: "list_items", views });
      expect(result?.viewPath).toBe("/");
      expect(result?.isRoot).toBe(true);
      expect(result?.hasParams).toBe(false);
    });

    it("finds static view for tool", () => {
      const result = getViewForTool({ toolName: "create_item", views });
      expect(result?.viewPath).toBe("/editor");
      expect(result?.isRoot).toBe(false);
      expect(result?.hasParams).toBe(false);
    });

    it("finds parameterized view for tool", () => {
      const result = getViewForTool({ toolName: "open_item", views });
      expect(result?.viewPath).toBe("/editor/:itemId");
      expect(result?.isRoot).toBe(false);
      expect(result?.hasParams).toBe(true);
      expect(result?.paramNames).toEqual(["itemId"]);
    });

    it("returns undefined for unknown tool", () => {
      const result = getViewForTool({ toolName: "unknown_tool", views });
      expect(result).toBeUndefined();
    });

    it("returns undefined when views is undefined", () => {
      const result = getViewForTool({ toolName: "any_tool", views: undefined });
      expect(result).toBeUndefined();
    });
  });

  describe("findPipByParams", () => {
    it("finds pip with matching params", () => {
      const pip: RoutablePipInstance = {
        instanceId: "inst_1",
        resourceUri: "ui://app/panel",
        serverName: "server",
        widgetState: { modelContent: { noteId: "note_123" } },
      };

      const result = findPipByParams({
        pipInstances: [pip],
        serverName: "server",
        resourceUri: "ui://app/panel",
        paramNames: ["noteId"],
        args: { noteId: "note_123" },
      });

      expect(result).toBe(pip);
    });

    it("returns undefined when params don't match", () => {
      const pip: RoutablePipInstance = {
        instanceId: "inst_1",
        resourceUri: "ui://app/panel",
        serverName: "server",
        widgetState: { modelContent: { noteId: "note_123" } },
      };

      const result = findPipByParams({
        pipInstances: [pip],
        serverName: "server",
        resourceUri: "ui://app/panel",
        paramNames: ["noteId"],
        args: { noteId: "note_456" },
      });

      expect(result).toBeUndefined();
    });
  });

  describe("findRootPip", () => {
    it("finds pip with empty modelContent", () => {
      const pip: RoutablePipInstance = {
        instanceId: "inst_1",
        resourceUri: "ui://app/panel",
        serverName: "server",
        widgetState: { modelContent: {} },
      };

      const result = findRootPip({
        pipInstances: [pip],
        serverName: "server",
        resourceUri: "ui://app/panel",
      });

      expect(result).toBe(pip);
    });

    it("finds pip with no widgetState", () => {
      const pip: RoutablePipInstance = {
        instanceId: "inst_1",
        resourceUri: "ui://app/panel",
        serverName: "server",
      };

      const result = findRootPip({
        pipInstances: [pip],
        serverName: "server",
        resourceUri: "ui://app/panel",
      });

      expect(result).toBe(pip);
    });

    it("ignores pip with params in modelContent", () => {
      const pip: RoutablePipInstance = {
        instanceId: "inst_1",
        resourceUri: "ui://app/panel",
        serverName: "server",
        widgetState: { modelContent: { noteId: "note_123" } },
      };

      const result = findRootPip({
        pipInstances: [pip],
        serverName: "server",
        resourceUri: "ui://app/panel",
      });

      expect(result).toBeUndefined();
    });
  });

  describe("findAnyPipForResource", () => {
    it("finds first pip matching server and resource", () => {
      const pip1: RoutablePipInstance = {
        instanceId: "inst_1",
        resourceUri: "ui://app/panel",
        serverName: "server",
        widgetState: { modelContent: { noteId: "note_1" } },
      };
      const pip2: RoutablePipInstance = {
        instanceId: "inst_2",
        resourceUri: "ui://app/panel",
        serverName: "server",
        widgetState: { modelContent: { noteId: "note_2" } },
      };

      const result = findAnyPipForResource({
        pipInstances: [pip1, pip2],
        serverName: "server",
        resourceUri: "ui://app/panel",
      });

      expect(result).toBe(pip1);
    });

    it("returns undefined when no matching pip exists", () => {
      const pip: RoutablePipInstance = {
        instanceId: "inst_1",
        resourceUri: "ui://other/panel",
        serverName: "server",
      };

      const result = findAnyPipForResource({
        pipInstances: [pip],
        serverName: "server",
        resourceUri: "ui://app/panel",
      });

      expect(result).toBeUndefined();
    });

    it("does not match pip from different server", () => {
      const pip: RoutablePipInstance = {
        instanceId: "inst_1",
        resourceUri: "ui://app/panel",
        serverName: "other-server",
      };

      const result = findAnyPipForResource({
        pipInstances: [pip],
        serverName: "server",
        resourceUri: "ui://app/panel",
      });

      expect(result).toBeUndefined();
    });
  });
});
