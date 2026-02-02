/**
 * View-Based Routing Logic
 *
 * Pure functions for pip instance routing. Extracted from controlPlane.ts
 * to enable testing without Electron dependencies.
 *
 * Instance Modes:
 * - "single" (default): One pip per resource. Reuses existing pip if found.
 * - "multiple": View-based routing for multiple pip instances.
 *
 * Routing scenarios (instanceMode: "multiple"):
 * 1. Explicit _instanceId in args → route to that pip directly
 * 2. Root view "/" → single instance, reuse if exists
 * 3. Parameterized view "/path/:param" → one instance per unique param value
 * 4. Static view "/path" → always create new instance (for create tools)
 *
 * Note: Explicit _instanceId (scenario 1) is always honored regardless of instanceMode.
 * The underscore prefix avoids collision with tool-defined arguments.
 *
 * If instanceMode is "multiple" and tool isn't in any view, pip creation is
 * skipped and a warning is logged. This indicates a misconfiguration.
 */

import type { WidgetState } from "../../shared/types";

// ============================================================================
// Types
// ============================================================================

/**
 * View routing configuration.
 * Maps URL-like path patterns to arrays of tool names.
 */
export type Views = Record<string, string[]>;

/**
 * Parsed view information for routing.
 */
export interface ParsedView {
  /** The view path pattern (e.g., "/", "/editor", "/editor/:noteId") */
  viewPath: string;
  /** Param names extracted from path (e.g., ["noteId"] from "/editor/:noteId") */
  paramNames: string[];
  /** Whether this is a root view ("/") */
  isRoot: boolean;
  /** Whether this view has params (instance-per-param behavior) */
  hasParams: boolean;
}

/**
 * Minimal pip instance interface for routing decisions.
 */
export interface RoutablePipInstance {
  instanceId: string;
  resourceUri: string;
  serverName: string;
  widgetState?: WidgetState;
}

/**
 * Result of resolving an instanceId for a tool call.
 */
export interface RoutingResult {
  instanceId: string | undefined;
  existingPip: RoutablePipInstance | undefined;
  viewPath: string | undefined;
  isReusingPip: boolean;
  /** Error message if routing failed (pip creation should be skipped) */
  error?: string;
}

/**
 * Resource metadata for pip routing decisions.
 */
export interface ResourceMetadata {
  uri: string;
  name: string;
  views?: Views;
  /** "single" (default) = one pip per resource, "multiple" = view-based routing */
  instanceMode?: "single" | "multiple";
}

// ============================================================================
// Pure Functions
// ============================================================================

/**
 * Extract param names from a view path pattern.
 * E.g., "/editor/:noteId" → ["noteId"]
 * E.g., "/folder/:folderId/file/:fileId" → ["folderId", "fileId"]
 */
export const extractParamNames = (viewPath: string): string[] => {
  const matches = viewPath.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g);
  return matches ? matches.map((m) => m.slice(1)) : [];
};

/**
 * Find the view path for a tool from views config.
 *
 * @param toolName - The tool being called
 * @param views - Views configuration from resource
 * @returns Parsed view information or undefined if tool not in views
 */
export const getViewForTool = ({
  toolName,
  views,
}: {
  toolName: string;
  views?: Views;
}): ParsedView | undefined => {
  if (!views) return undefined;

  for (const [viewPath, tools] of Object.entries(views)) {
    if (tools.includes(toolName)) {
      const paramNames = extractParamNames(viewPath);
      return {
        viewPath,
        paramNames,
        isRoot: viewPath === "/",
        hasParams: paramNames.length > 0,
      };
    }
  }

  return undefined;
};

/**
 * Generate a unique instance ID for pip routing.
 * Format matches SDK format for consistency.
 */
export const generateInstanceId = (): string => {
  return `inst_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
};

/**
 * Find an existing pip by matching param values in widgetState.modelContent.
 *
 * For view paths like "/editor/:noteId", finds the pip where
 * widgetState.modelContent.noteId matches the arg value.
 */
export const findPipByParams = ({
  pipInstances,
  serverName,
  resourceUri,
  paramNames,
  args,
}: {
  pipInstances: Iterable<RoutablePipInstance>;
  serverName: string;
  resourceUri: string;
  paramNames: string[];
  args: Record<string, unknown>;
}): RoutablePipInstance | undefined => {
  for (const pip of pipInstances) {
    if (pip.resourceUri !== resourceUri || pip.serverName !== serverName) {
      continue;
    }

    const modelContent = pip.widgetState?.modelContent;
    if (modelContent && typeof modelContent === "object") {
      const mc = modelContent as Record<string, unknown>;
      const allMatch = paramNames.every((name) => {
        const argValue = args[name];
        return argValue !== undefined && mc[name] === argValue;
      });
      if (allMatch) {
        return pip;
      }
    }
  }
  return undefined;
};

/**
 * Find any existing pip for a resource (instanceMode: "single").
 * Returns the first pip found for the server/resource combination.
 */
export const findAnyPipForResource = ({
  pipInstances,
  serverName,
  resourceUri,
}: {
  pipInstances: Iterable<RoutablePipInstance>;
  serverName: string;
  resourceUri: string;
}): RoutablePipInstance | undefined => {
  for (const pip of pipInstances) {
    if (pip.resourceUri === resourceUri && pip.serverName === serverName) {
      return pip;
    }
  }
  return undefined;
};

/**
 * Find an existing pip for a root view ("/").
 * Root views have single-instance behavior.
 */
export const findRootPip = ({
  pipInstances,
  serverName,
  resourceUri,
}: {
  pipInstances: Iterable<RoutablePipInstance>;
  serverName: string;
  resourceUri: string;
}): RoutablePipInstance | undefined => {
  for (const pip of pipInstances) {
    if (pip.resourceUri === resourceUri && pip.serverName === serverName) {
      const modelContent = pip.widgetState?.modelContent;
      if (!modelContent || (typeof modelContent === "object" && Object.keys(modelContent).length === 0)) {
        return pip;
      }
      if (typeof modelContent === "object" && (modelContent as Record<string, unknown>).view === "/") {
        return pip;
      }
    }
  }
  return undefined;
};

/**
 * Resolve instanceId for a tool call using view-based routing.
 *
 * Instance modes:
 * - "single" (default) → one pip per resource, reuse if exists
 * - "multiple" → view-based routing (see patterns below)
 *
 * View-based routing patterns (instanceMode: "multiple"):
 * 1. Explicit _instanceId in args → route to that pip directly
 * 2. Root view "/" → single instance, reuse if exists
 * 3. Parameterized view "/path/:param" → one instance per unique param value
 * 4. Static view "/path" → always create new instance (for create tools)
 *
 * Error (returns error string, pip creation skipped):
 * - Tool not in any view → misconfiguration
 *
 * @returns Object with instanceId, existing pip (if any), view path, and reuse flag
 */
export const resolveInstanceIdForTool = ({
  pipInstances,
  getPipById,
  resourceMetadata,
  serverName,
  toolName,
  args,
  resourceUri,
}: {
  pipInstances: Iterable<RoutablePipInstance>;
  getPipById: (id: string) => RoutablePipInstance | undefined;
  resourceMetadata: ResourceMetadata | undefined;
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  resourceUri: string;
}): RoutingResult => {
  const view = getViewForTool({ toolName, views: resourceMetadata?.views });
  const instanceMode = resourceMetadata?.instanceMode ?? "single";

  // 1. Explicit _instanceId in args → route to that pip directly (always honored)
  // Note: Uses underscore prefix to avoid collision with tool-defined arguments
  const instanceIdFromArgs = typeof args._instanceId === "string" ? args._instanceId : undefined;
  if (instanceIdFromArgs) {
    const existingPip = getPipById(instanceIdFromArgs);
    if (existingPip) {
      return {
        instanceId: existingPip.instanceId,
        existingPip,
        viewPath: view?.viewPath,
        isReusingPip: true,
      };
    }
    // instanceId passed but pip not found → create new pip with that ID
    return {
      instanceId: instanceIdFromArgs,
      existingPip: undefined,
      viewPath: view?.viewPath,
      isReusingPip: false,
    };
  }

  // 2. instanceMode: "single" (default) → reuse any existing pip for this resource
  if (instanceMode === "single") {
    const existingPip = findAnyPipForResource({ pipInstances, serverName, resourceUri });
    if (existingPip) {
      return {
        instanceId: existingPip.instanceId,
        existingPip,
        viewPath: view?.viewPath,
        isReusingPip: true,
      };
    }
    return {
      instanceId: generateInstanceId(),
      existingPip: undefined,
      viewPath: view?.viewPath,
      isReusingPip: false,
    };
  }

  // ===========================================================================
  // instanceMode: "multiple" → view-based routing
  // ===========================================================================

  // 2. Root view "/" → single instance, reuse if exists
  if (view?.isRoot) {
    const existingPip = findRootPip({ pipInstances, serverName, resourceUri });
    if (existingPip) {
      return {
        instanceId: existingPip.instanceId,
        existingPip,
        viewPath: view.viewPath,
        isReusingPip: true,
      };
    }
    return {
      instanceId: generateInstanceId(),
      existingPip: undefined,
      viewPath: view.viewPath,
      isReusingPip: false,
    };
  }

  // 3. Parameterized view "/path/:param" → one instance per unique param value
  if (view?.hasParams) {
    const allParamsPresent = view.paramNames.every((name) => args[name] !== undefined);

    if (allParamsPresent) {
      const existingPip = findPipByParams({
        pipInstances,
        serverName,
        resourceUri,
        paramNames: view.paramNames,
        args,
      });

      if (existingPip) {
        return {
          instanceId: existingPip.instanceId,
          existingPip,
          viewPath: view.viewPath,
          isReusingPip: true,
        };
      }
    }

    // No matching pip found → create new pip
    return {
      instanceId: generateInstanceId(),
      existingPip: undefined,
      viewPath: view.viewPath,
      isReusingPip: false,
    };
  }

  // 4. Static view "/path" (no params, not root) → always create new instance
  // Used for tools that create new resources (e.g., notes_create opens a new editor)
  if (view && !view.isRoot && !view.hasParams) {
    return {
      instanceId: generateInstanceId(),
      existingPip: undefined,
      viewPath: view.viewPath,
      isReusingPip: false,
    };
  }

  // ===========================================================================
  // Error scenario - tool has UI but is not in any view (misconfiguration)
  // ===========================================================================

  return {
    instanceId: undefined,
    existingPip: undefined,
    viewPath: undefined,
    isReusingPip: false,
    error: `Tool "${toolName}" has UI but is not in any view. Add it to views config.`,
  };
};
