/**
 * Icon Utilities
 *
 * Provides utilities for handling MCP UI Resource icons.
 * Only supports single-color SVG icons that use `currentColor`.
 * Includes SVG sanitization to prevent XSS attacks.
 *
 * Requirements:
 * - Icons MUST be SVG format (data URI)
 * - Icons MUST use `currentColor` for stroke/fill (single-color only)
 * - Icons are styled by the host via CSS color property
 */

import type { ResourceIcon } from "../shared/types";

export type { ResourceIcon };

/**
 * Maximum icon size in bytes (10KB).
 * Icons larger than this will be rejected.
 */
export const MAX_ICON_SIZE_BYTES = 10 * 1024;

/**
 * Validated icon ready for rendering.
 * Only SVG icons are supported.
 */
export interface ValidatedIcon {
  /** The icon type - only "svg" is supported */
  type: "svg";
  /** The sanitized SVG content (raw SVG, not data URI) */
  svg: string;
  /** Alt text for accessibility */
  alt?: string;
}

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
 * Checks if a string is a valid SVG data URI.
 *
 * @param str - The string to check
 * @returns True if the string is an SVG data URI
 */
export const isSvgDataUri = (str: string): boolean => {
  return str.startsWith("data:image/svg+xml");
};

/**
 * Decodes a data URI to its raw content.
 *
 * @param dataUri - The data URI to decode
 * @returns The decoded content or null if invalid
 */
const decodeDataUri = (dataUri: string): string | null => {
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
 * Validates that an SVG only uses currentColor for stroke and fill.
 * This ensures the icon can be styled by the host via CSS color property.
 *
 * @param element - The SVG element to validate
 * @returns True if the SVG is single-color compatible
 */
const validateSingleColor = (element: Element): boolean => {
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
    if (!validateSingleColor(child)) {
      return false;
    }
  }

  return true;
};

/**
 * Sanitizes an SVG string by removing potentially dangerous elements and attributes.
 * Uses a strict allowlist approach for maximum security.
 * Also validates that the SVG uses currentColor for single-color theming.
 *
 * @param svgContent - The raw SVG content to sanitize
 * @returns The sanitized SVG content or null if invalid
 */
export const sanitizeSvg = (svgContent: string): string | null => {
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
     * Recursively sanitizes an element and its children.
     * Removes disallowed elements and attributes.
     */
    const sanitizeElement = (element: Element): void => {
      // Remove disallowed elements
      const children = Array.from(element.children);
      for (const child of children) {
        const tagName = child.tagName.toLowerCase();
        if (!SAFE_SVG_ELEMENTS.has(tagName)) {
          console.warn(`[IconUtils] Removing disallowed SVG element: ${tagName}`);
          child.remove();
          continue;
        }
        sanitizeElement(child);
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

    sanitizeElement(svg);

    // Validate single-color requirement (must use currentColor)
    if (!validateSingleColor(svg)) {
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
 * Validates and sanitizes an icon from MCP UI Resource metadata.
 * Only SVG icons using currentColor are supported.
 *
 * Requirements:
 * - Must be an SVG data URI
 * - Must use currentColor for stroke/fill (single-color)
 * - Must be under 10KB
 *
 * @param icon - The raw icon data from resource metadata
 * @returns A validated icon object with raw SVG content, or null if invalid
 */
export const validateIcon = (icon: ResourceIcon | undefined): ValidatedIcon | null => {
  if (!icon || !icon.data) {
    return null;
  }

  const { data, alt } = icon;

  // Check size limit
  const sizeBytes = new TextEncoder().encode(data).length;
  if (sizeBytes > MAX_ICON_SIZE_BYTES) {
    console.warn(
      `[IconUtils] Icon exceeds size limit: ${sizeBytes} bytes (max: ${MAX_ICON_SIZE_BYTES})`
    );
    return null;
  }

  // Only SVG data URIs are supported
  if (!isSvgDataUri(data)) {
    console.warn("[IconUtils] Only SVG icons are supported. Icon must be a data:image/svg+xml URI");
    return null;
  }

  // Decode the SVG content
  const svgContent = decodeDataUri(data);
  if (!svgContent) {
    console.warn("[IconUtils] Failed to decode SVG data URI");
    return null;
  }

  // Sanitize and validate (includes single-color check)
  const sanitized = sanitizeSvg(svgContent);
  if (!sanitized) {
    console.warn("[IconUtils] SVG validation/sanitization failed");
    return null;
  }

  // Return raw SVG content for inline rendering with CSS color inheritance
  return { type: "svg", svg: sanitized, alt };
};

