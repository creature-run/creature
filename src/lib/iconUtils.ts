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
import { decodeDataUri, sanitizeSvg } from "./utils";

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
 * Checks if a string is a valid SVG data URI.
 *
 * @param str - The string to check
 * @returns True if the string is an SVG data URI
 */
export const isSvgDataUri = (str: string): boolean => {
  return str.startsWith("data:image/svg+xml");
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
  const svgContent = decodeDataUri({ dataUri: data });
  if (!svgContent) {
    console.warn("[IconUtils] Failed to decode SVG data URI");
    return null;
  }

  // Sanitize and validate (includes single-color check)
  const sanitized = sanitizeSvg({ svgContent });
  if (!sanitized) {
    console.warn("[IconUtils] SVG validation/sanitization failed");
    return null;
  }

  // Return raw SVG content for inline rendering with CSS color inheritance
  return { type: "svg", svg: sanitized, alt };
};

