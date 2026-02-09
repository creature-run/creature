import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { WidgetState } from "../shared/types";
import type { PersistedPipSnapshot, PersistedPipState } from "../electron/mcp/controlPlane";

/**
 * Utility function for merging Tailwind CSS classes.
 * 
 * Combines clsx for conditional classes with tailwind-merge
 * to properly handle conflicting Tailwind utility classes.
 * This is the standard utility used by ShadCN UI components.
 * 
 * @param inputs - Class values to merge (strings, arrays, objects)
 * @returns Merged class string with conflicts resolved
 */
export const cn = (...inputs: ClassValue[]) => {
  return twMerge(clsx(inputs));
};

/**
 * Check whether a value is a plain object.
 *
 * This keeps object inspection safe and avoids treating arrays as objects.
 *
 * @param params - Input wrapper for the value to check
 * @param params.value - Value to inspect
 * @returns True when the value is a non-null, non-array object
 */
export const isPlainObject = ({ value }: { value: unknown }): boolean => {
  if (!value || typeof value !== "object") return false;
  return !Array.isArray(value);
};

/**
 * Extract param names from a view path pattern.
 * E.g., "/editor/:noteId" → ["noteId"]
 * E.g., "/folder/:folderId/file/:fileId" → ["folderId", "fileId"]
 *
 * @param params - Input wrapper for the view path pattern
 * @param params.viewPath - URL-like path pattern to parse
 * @returns List of parameter names in the path pattern
 */
export const extractParamNames = ({
  viewPath,
}: {
  viewPath: string;
}): string[] => {
  const matches = viewPath.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g);
  return matches ? matches.map((m) => m.slice(1)) : [];
};

/**
 * Generate a unique instance ID for pip routing.
 * Format matches SDK format for consistency.
 *
 * @param params - Input wrapper for customization options
 * @param params.prefix - Prefix for the generated ID
 * @returns A unique instance identifier string
 */
export const generateInstanceId = ({
  prefix = "inst",
}: {
  prefix?: string;
}): string => {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
};

/**
 * Normalize file data to a string for transport and logging.
 *
 * Ensures URL and binary data are represented consistently while preserving
 * JSON-serializable objects for downstream processing.
 *
 * @param params - Input wrapper for file data
 * @param params.data - Raw file data input
 * @returns String representation of the input data
 */
export const normalizeFileData = ({ data }: { data: unknown }): string => {
  if (typeof data === "string") return data;
  if (data instanceof URL) return data.toString();
  if (data instanceof Uint8Array) {
    return Buffer.from(data).toString("base64");
  }
  return JSON.stringify(data);
};

/**
 * Allowlist of safe SVG elements.
 * Only these elements are permitted in sanitized SVGs.
 */
const SAFE_SVG_ELEMENTS = new Set([
  "svg",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "g",
  "defs",
  "clipPath",
  "mask",
  "use",
  "symbol",
  "linearGradient",
  "radialGradient",
  "stop",
  "text",
  "tspan",
  "title",
  "desc",
]);

/**
 * Allowlist of safe SVG attributes (all lowercase for case-insensitive matching).
 * Only these attributes are permitted in sanitized SVGs.
 */
const SAFE_SVG_ATTRIBUTES = new Set([
  // Core attributes
  "id",
  "class",
  "style",
  // Dimensional attributes
  "width",
  "height",
  "x",
  "y",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x1",
  "y1",
  "x2",
  "y2",
  // Path/shape attributes
  "d",
  "points",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "fill-opacity",
  "opacity",
  "fill-rule",
  "clip-rule",
  // Transform attributes
  "transform",
  "transform-origin",
  // Viewbox and presentation (lowercase for matching)
  "viewbox",
  "preserveaspectratio",
  "xmlns",
  "xmlns:xlink",
  // Gradient attributes
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  // Clip/mask attributes
  "clip-path",
  "mask",
  // Text attributes
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  // Reference attributes (for use, clipPath, mask)
  "href",
  "xlink:href",
]);

/**
 * Validate that an SVG only uses currentColor for stroke and fill.
 * This ensures the icon can be styled by the host via CSS color property.
 *
 * @param params - Input wrapper for the SVG element to validate
 * @param params.element - The SVG element to validate
 * @returns True if the SVG is single-color compatible
 */
const validateSingleColor = ({ element }: { element: Element }): boolean => {
  const attrs = Array.from(element.attributes);

  for (const attr of attrs) {
    const name = attr.name.toLowerCase();
    const value = attr.value.toLowerCase();

    // Check stroke and fill attributes
    if (name === "stroke" || name === "fill") {
      // Allow: currentColor, none, transparent
      if (
        value !== "currentcolor" &&
        value !== "none" &&
        value !== "transparent" &&
        value !== ""
      ) {
        console.warn(`[IconUtils] SVG has non-currentColor ${name}: ${value}`);
        return false;
      }
    }
  }

  // Check children recursively
  for (const child of Array.from(element.children)) {
    if (!validateSingleColor({ element: child })) {
      return false;
    }
  }

  return true;
};

/**
 * Decode a data URI to its raw content.
 *
 * @param params - Input wrapper for the data URI
 * @param params.dataUri - Data URI to decode
 * @returns Decoded content or null if invalid
 */
export const decodeDataUri = ({ dataUri }: { dataUri: string }): string | null => {
  try {
    const match = dataUri.match(/^data:[^;]+;base64,(.+)$/);
    if (match) {
      return atob(match[1]);
    }
    // Handle non-base64 data URIs
    const plainMatch = dataUri.match(/^data:[^,]+,(.+)$/);
    if (plainMatch) {
      return decodeURIComponent(plainMatch[1]);
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * Sanitize an SVG string by removing potentially dangerous elements and attributes.
 * Uses a strict allowlist approach for maximum security.
 * Also validates that the SVG uses currentColor for single-color theming.
 *
 * @param params - Input wrapper for the SVG content to sanitize
 * @param params.svgContent - Raw SVG content to sanitize
 * @returns The sanitized SVG content or null if invalid
 */
export const sanitizeSvg = ({ svgContent }: { svgContent: string }): string | null => {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgContent, "image/svg+xml");

    // Check for parsing errors
    const parseError = doc.querySelector("parsererror");
    if (parseError) {
      console.warn("[IconUtils] SVG parsing error:", parseError.textContent);
      return null;
    }

    const svg = doc.documentElement;
    if (svg.tagName.toLowerCase() !== "svg") {
      console.warn("[IconUtils] Root element is not SVG");
      return null;
    }

    /**
     * Recursively sanitize an element and its children.
     * Removes disallowed elements and attributes for safe rendering.
     *
     * @param params - Input wrapper for the element to sanitize
     * @param params.element - SVG element to sanitize
     */
    const sanitizeElement = ({ element }: { element: Element }): void => {
      // Remove disallowed elements
      const children = Array.from(element.children);
      for (const child of children) {
        const tagName = child.tagName.toLowerCase();
        if (!SAFE_SVG_ELEMENTS.has(tagName)) {
          console.warn(`[IconUtils] Removing disallowed SVG element: ${tagName}`);
          child.remove();
          continue;
        }
        sanitizeElement({ element: child });
      }

      // Remove disallowed attributes
      const attrs = Array.from(element.attributes);
      for (const attr of attrs) {
        const attrName = attr.name.toLowerCase();
        // Remove event handlers (onclick, onload, etc.)
        if (attrName.startsWith("on")) {
          console.warn(`[IconUtils] Removing event handler: ${attrName}`);
          element.removeAttribute(attr.name);
          continue;
        }
        // Remove javascript: URLs
        if (attr.value.toLowerCase().includes("javascript:")) {
          console.warn(`[IconUtils] Removing javascript URL in: ${attrName}`);
          element.removeAttribute(attr.name);
          continue;
        }
        // Remove disallowed attributes
        if (!SAFE_SVG_ATTRIBUTES.has(attrName)) {
          console.warn(`[IconUtils] Removing disallowed attribute: ${attrName}`);
          element.removeAttribute(attr.name);
        }
      }
    };

    sanitizeElement({ element: svg });

    // Validate single-color requirement (must use currentColor)
    if (!validateSingleColor({ element: svg })) {
      console.warn("[IconUtils] SVG must use currentColor for stroke/fill");
      return null;
    }

    // Serialize back to string
    const serializer = new XMLSerializer();
    return serializer.serializeToString(svg);
  } catch (error) {
    console.error("[IconUtils] SVG sanitization error:", error);
    return null;
  }
};

/**
 * Normalize a widget state payload to a safe, typed structure.
 *
 * This protects downstream consumers from malformed widget state shapes
 * while preserving valid model/private content and image identifiers.
 *
 * @param params - Input wrapper for the raw widget state
 * @param params.value - Unknown widget state input
 * @returns Normalized widget state or undefined when invalid
 */
export const normalizeWidgetState = ({
  value,
}: {
  value: unknown;
}): WidgetState | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const next: WidgetState = {};

  if (
    raw.modelContent === null ||
    typeof raw.modelContent === "string" ||
    (typeof raw.modelContent === "object" && !Array.isArray(raw.modelContent))
  ) {
    next.modelContent = raw.modelContent as WidgetState["modelContent"];
  }

  if (
    raw.privateContent === null ||
    (typeof raw.privateContent === "object" && !Array.isArray(raw.privateContent))
  ) {
    next.privateContent = raw.privateContent as WidgetState["privateContent"];
  }

  if (Array.isArray(raw.imageIds)) {
    next.imageIds = raw.imageIds.filter((id): id is string => typeof id === "string");
  }

  if (
    next.modelContent === undefined &&
    next.privateContent === undefined &&
    next.imageIds === undefined
  ) {
    return undefined;
  }

  return next;
};

/**
 * Normalize a persisted pip snapshot to a validated shape.
 *
 * Ensures required identifiers and metadata are present and sensible,
 * while preserving optional flags and widget state when valid.
 *
 * @param params - Input wrapper for the raw snapshot
 * @param params.value - Unknown persisted snapshot payload
 * @returns Normalized snapshot or null when invalid
 */
export const normalizePersistedPipSnapshot = ({
  value,
}: {
  value: unknown;
}): PersistedPipSnapshot | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;
  if (
    typeof raw.instanceId !== "string" ||
    typeof raw.serverName !== "string" ||
    typeof raw.resourceUri !== "string" ||
    typeof raw.toolName !== "string" ||
    typeof raw.title !== "string"
  ) {
    return null;
  }

  if (
    raw.instanceId.length === 0 ||
    raw.serverName.length === 0 ||
    raw.resourceUri.length === 0
  ) {
    return null;
  }

  const normalized: PersistedPipSnapshot = {
    instanceId: raw.instanceId,
    serverName: raw.serverName,
    resourceUri: raw.resourceUri,
    toolName: raw.toolName,
    title: raw.title,
    createdAt:
      typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
        ? Number(raw.createdAt)
        : Date.now(),
  };

  if (typeof raw.triggeredByTool === "boolean") {
    normalized.triggeredByTool = raw.triggeredByTool;
  }

  if (typeof raw.openInBackground === "boolean") {
    normalized.openInBackground = raw.openInBackground;
  }

  const widgetState = normalizeWidgetState({ value: raw.widgetState });
  if (widgetState) {
    normalized.widgetState = widgetState;
  }

  return normalized;
};

/**
 * Normalize a persisted pip state payload to a safe shape.
 *
 * Ensures pip order integrity and active pip correctness even when
 * the persisted data contains partial or malformed values.
 *
 * @param params - Input wrapper for raw persisted pip state
 * @param params.value - Unknown persisted pip state input
 * @returns Normalized persisted pip state
 */
export const normalizePersistedPipState = ({
  value,
}: {
  value: unknown;
}): PersistedPipState => {
  if (!value || typeof value !== "object") {
    return {
      pips: [],
      pipOrder: [],
      activePipId: null,
    };
  }

  const raw = value as {
    pips?: unknown;
    pipOrder?: unknown;
    activePipId?: unknown;
  };

  const pips = Array.isArray(raw.pips)
    ? raw.pips
        .map((snapshot) => normalizePersistedPipSnapshot({ value: snapshot }))
        .filter((snapshot): snapshot is PersistedPipSnapshot => !!snapshot)
    : [];

  const pipIds = new Set(pips.map((snapshot) => snapshot.instanceId));
  const pipOrder: string[] = [];

  /**
   * Add a pip ID to the ordered list once, preserving persisted ordering.
   *
   * This prevents duplicates while ensuring the order only includes
   * known pips that were successfully normalized.
   *
   * @param params - Input wrapper for the instance ID
   * @param params.instanceId - Pip instance ID to include
   */
  const addPipOrder = ({ instanceId }: { instanceId: string }) => {
    if (!pipIds.has(instanceId)) return;
    if (pipOrder.includes(instanceId)) return;
    pipOrder.push(instanceId);
  };

  if (Array.isArray(raw.pipOrder)) {
    for (const value of raw.pipOrder) {
      if (typeof value === "string") {
        addPipOrder({ instanceId: value });
      }
    }
  }

  for (const snapshot of pips) {
    addPipOrder({ instanceId: snapshot.instanceId });
  }

  const activePipId =
    typeof raw.activePipId === "string" && pipIds.has(raw.activePipId)
      ? raw.activePipId
      : null;

  return {
    pips,
    pipOrder,
    activePipId,
  };
};

/**
 * Strip large image data from tool results to prevent token limit errors.
 *
 * Large image content can be 100k+ tokens when base64 encoded.
 * This replaces image content with a placeholder message while preserving
 * the result structure for the agent.
 *
 * @param params - Input wrapper for the tool result
 * @param params.result - Tool result payload to sanitize
 * @returns Sanitized tool result payload
 */
export const stripLargeImageData = ({ result }: { result: unknown }): unknown => {
  if (!result || typeof result !== "object") return result;

  const resultObj = result as Record<string, unknown>;
  if (!resultObj.content || !Array.isArray(resultObj.content)) return result;

  const hasLargeImage = resultObj.content.some(
    (item: { type?: string; data?: string }) =>
      item.type === "image" && item.data && item.data.length > 1000
  );

  if (!hasLargeImage) return result;

  // Replace image content with placeholder
  return {
    ...resultObj,
    content: resultObj.content.map((item: { type?: string; data?: string }) => {
      if (item.type === "image" && item.data && item.data.length > 1000) {
        return {
          type: "text",
          text: "[Image omitted from conversation to save tokens]",
        };
      }
      return item;
    }),
  };
};

/**
 * Truncates a file path from the left side at path boundaries.
 * Ensures truncation happens at directory separators for clean display.
 * 
 * Examples:
 * - "/Users/a/Projects/serverless/svg" → ".../Projects/serverless/svg"
 * - "/short/path" → "/short/path" (no truncation)
 * 
 * @param path - The file path to truncate
 * @param maxLength - Maximum length of the resulting string
 * @returns Truncated path with "..." prefix if needed
 */
export const truncatePathLeft = (path: string, maxLength: number): string => {
  if (path.length <= maxLength) return path;
  
  const segments = path.split('/').filter(s => s.length > 0); // Remove empty segments
  const ellipsis = '...';
  
  // Always try to show at least the last segment
  let result = segments[segments.length - 1];
  
  // Work backwards, adding segments until we exceed maxLength
  for (let i = segments.length - 2; i >= 0; i--) {
    const newResult = segments[i] + '/' + result;
    const withEllipsis = ellipsis + '/' + newResult;
    
    if (withEllipsis.length >= maxLength) {
      // Adding this segment would meet or exceed limit, use what we have
      return ellipsis + '/' + result;
    }
    
    result = newResult;
  }
  
  // All segments fit, but was truncated, so add ellipsis
  return ellipsis + '/' + result;
};

/**
 * Formats a price value to USD currency, rounded to the nearest cent.
 * 
 * Handles floating point precision issues by rounding to 2 decimal places
 * before formatting. Returns a formatted string like "$17.89".
 * 
 * @param amount - The price amount to format
 * @returns Formatted currency string (e.g., "$17.89")
 */
export const formatPrice = (amount: number): string => {
  // Round to nearest cent to avoid floating point issues
  const rounded = Math.round(amount * 100) / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rounded);
};

/**
 * Initiates the upgrade to Starter plan flow.
 * Opens Stripe Checkout in the user's browser.
 * 
 * This is the single source of truth for all upgrade actions.
 * Use this function from any component that needs to trigger an upgrade.
 * 
 * @returns Promise with success status and optional error message
 */
export const startUpgrade = async (): Promise<{ success: boolean; error?: string }> => {
  try {
    const result = await window.electronAPI.billing.checkout();
    if (result.error) {
      console.error("[Billing] Checkout error:", result.error);
      return { success: false, error: result.error };
    }
    return { success: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Failed to start checkout";
    console.error("[Billing] Checkout exception:", errorMessage);
    return { success: false, error: errorMessage };
  }
};

/**
 * Opens the Stripe Customer Portal for subscription management.
 * Use this for managing existing subscriptions (cancel, update payment, etc).
 * 
 * @returns Promise with success status and optional error message
 */
export const openSubscriptionPortal = async (): Promise<{ success: boolean; error?: string }> => {
  try {
    const result = await window.electronAPI.billing.portal();
    if (result.error) {
      console.error("[Billing] Portal error:", result.error);
      return { success: false, error: result.error };
    }
    return { success: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Failed to open portal";
    console.error("[Billing] Portal exception:", errorMessage);
    return { success: false, error: errorMessage };
  }
};
