/**
 * useViews Hook
 *
 * Provides view-based routing for MCP Apps. The hook:
 * - Tracks current view based on tool results
 * - Extracts params from path patterns (e.g., /editor/:noteId)
 * - Works on all hosts (multi-instance on Creature, single-instance elsewhere)
 *
 * @example
 * ```tsx
 * const views = {
 *   "/": ["notes_list"],
 *   "/editor": ["notes_create"],
 *   "/editor/:noteId": ["notes_open", "notes_save", "notes_delete"]
 * };
 *
 * function App() {
 *   const { view, params, data } = useViews(views);
 *
 *   return (
 *     <div>
 *       {view === "/" && <ListView notes={data?.notes} />}
 *       {view === "/editor/:noteId" && <EditorView note={data?.note} />}
 *     </div>
 *   );
 * }
 * ```
 */

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useHost } from "./useHost.js";
import type { ToolResult } from "../core/types.js";

/**
 * Views configuration type.
 * Maps URL-like path patterns to arrays of tool names.
 */
export type Views = Record<string, string[]>;

/**
 * Return type for useViews hook.
 */
export interface UseViewsReturn<T = Record<string, unknown>> {
  /** Current view path pattern (e.g., "/" or "/editor/:noteId") */
  view: string;
  /** Resolved params from the current view (e.g., { noteId: "abc" }) */
  params: Record<string, string>;
  /** Data from the most recent tool result */
  data: T | null;
  /** Tool name from the most recent tool result */
  toolName: string | null;
  /** Whether the hook has received its first tool result */
  isInitialized: boolean;
}

/**
 * Extended tool result with tool name metadata.
 * Control Plane includes this for view routing.
 */
interface ExtendedToolResult extends ToolResult {
  toolName?: string;
}

/**
 * Extract param names from a path pattern.
 * E.g., "/editor/:noteId" → ["noteId"]
 */
function extractParamNames(pathPattern: string): string[] {
  const matches = pathPattern.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g);
  return matches ? matches.map((m) => m.slice(1)) : [];
}

/**
 * Extract param values from structured content based on path pattern.
 */
function extractParams(
  pathPattern: string,
  data: Record<string, unknown>
): Record<string, string> {
  const paramNames = extractParamNames(pathPattern);
  const params: Record<string, string> = {};

  for (const name of paramNames) {
    const value = data[name];
    if (typeof value === "string") {
      params[name] = value;
    } else if (typeof value === "number") {
      params[name] = String(value);
    }
  }

  return params;
}

/**
 * Find the best matching view for a tool, preferring more specific paths.
 * E.g., if tool is in both "/editor" and "/editor/:noteId", prefer the more specific one
 * when params are available.
 */
function findViewForTool(
  toolName: string,
  toolToViews: Map<string, string[]>,
  data: Record<string, unknown> | null
): string | null {
  const possibleViews = toolToViews.get(toolName);
  if (!possibleViews || possibleViews.length === 0) return null;

  if (possibleViews.length === 1) return possibleViews[0];

  // Multiple views - find the most specific one where all params are available
  // Sort by specificity (more params = more specific)
  const viewsWithParams = possibleViews.map((view) => ({
    view,
    paramNames: extractParamNames(view),
  }));

  // Sort by number of params (descending)
  viewsWithParams.sort((a, b) => b.paramNames.length - a.paramNames.length);

  // Find the most specific view where all params are present in data
  if (data) {
    for (const { view, paramNames } of viewsWithParams) {
      const allParamsPresent = paramNames.every((name) => name in data);
      if (allParamsPresent) return view;
    }
  }

  // Fallback to least specific (no params or fewest params)
  return viewsWithParams[viewsWithParams.length - 1].view;
}

/**
 * React hook for view-based routing in MCP Apps.
 *
 * Automatically handles view transitions based on tool results. Works across
 * all host environments (Creature, ChatGPT, standalone).
 *
 * @param views - View configuration mapping path patterns to tool names
 * @returns Current view state including path pattern, params, and data
 */
export function useViews<T = Record<string, unknown>>(
  views: Views
): UseViewsReturn<T> {
  const { onToolResult, exp, isReady, hostContext, widgetState } = useHost();

  // Build reverse lookup: tool name → view paths (a tool can be in multiple views)
  const toolToViews = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [viewPath, tools] of Object.entries(views)) {
      for (const tool of tools) {
        const existing = map.get(tool) || [];
        existing.push(viewPath);
        map.set(tool, existing);
      }
    }
    return map;
  }, [views]);

  // State
  const [view, setView] = useState<string>("/");
  const [params, setParams] = useState<Record<string, string>>({});
  const [data, setData] = useState<T | null>(null);
  const [toolName, setToolName] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  // Track if we've processed the initial result
  const hasProcessedInitial = useRef(false);

  /**
   * Process a tool result and update view state.
   */
  const processToolResult = useCallback(
    (result: ExtendedToolResult, overrideToolName?: string) => {
      const structured = result.structuredContent as Record<string, unknown> | undefined;
      const resultToolName = overrideToolName || result.toolName;

      if (!resultToolName) {
        // Can't determine view without tool name
        // Still update data if we have structured content
        if (structured) {
          setData(structured as T);
        }
        return;
      }

      // Find the best view for this tool
      const targetView = findViewForTool(resultToolName, toolToViews, structured || null);
      if (!targetView) {
        // Tool not in views config - just update data
        if (structured) {
          setData(structured as T);
        }
        return;
      }

      // Extract params from the data
      const extractedParams = structured ? extractParams(targetView, structured) : {};

      setView(targetView);
      setParams(extractedParams);
      if (structured) {
        setData(structured as T);
      }
      setToolName(resultToolName);
      setIsInitialized(true);
    },
    [toolToViews]
  );

  /**
   * Handle initial view state based on how the view was opened.
   *
   * - "tool": Use buffered tool result to determine initial view
   * - "user": Default to "/" root view
   * - "restore": Use widgetState.modelContent.view to restore previous view
   */
  useEffect(() => {
    if (!isReady || hasProcessedInitial.current) return;
    hasProcessedInitial.current = true;

    const triggeredBy = hostContext?.openContext?.triggeredBy;

    // Restore scenario: use widgetState to restore previous view
    if (triggeredBy === "restore") {
      const modelContent = widgetState?.modelContent as Record<string, unknown> | undefined;
      const restoredView = modelContent?.view as string | undefined;
      if (restoredView && restoredView in views) {
        setView(restoredView);
        // Extract params from modelContent (e.g., noteId, etc.)
        const extractedParams = modelContent ? extractParams(restoredView, modelContent) : {};
        setParams(extractedParams);
        // Restore data from widgetState.privateContent if available
        const privateContent = widgetState?.privateContent as T | undefined;
        if (privateContent) {
          setData(privateContent);
        }
        setIsInitialized(true);
        return;
      }
      // Fall through to default if no valid view in widgetState
    }

    // Tool-triggered: use buffered tool result
    const initial = exp.getInitialToolResult() as ExtendedToolResult | null;
    if (initial) {
      processToolResult(initial);
    } else {
      // User-triggered or no tool result - start at root view
      setView("/");
      setIsInitialized(true);
    }
  }, [isReady, exp, processToolResult, hostContext, widgetState, views]);

  /**
   * Subscribe to subsequent tool results.
   */
  useEffect(() => {
    return onToolResult((result) => {
      processToolResult(result as ExtendedToolResult);
    });
  }, [onToolResult, processToolResult]);

  return {
    view,
    params,
    data,
    toolName,
    isInitialized,
  };
}
