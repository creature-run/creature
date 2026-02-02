/**
 * Shared Types
 *
 * Common type definitions used across main process, preload, and renderer.
 * Consolidating these here eliminates duplication and ensures consistency.
 */

/**
 * Icon data structure from MCP UI Resource metadata.
 * Follows the _meta.ui.icon pattern from MCP Apps spec extension.
 *
 * Icons can be:
 * - Emoji (e.g., "📁")
 * - Data URI (base64 PNG/SVG, should use currentColor for theming)
 * - External URL (https://)
 */
export interface ResourceIcon {
  /** Icon data - can be emoji, data URI (base64 PNG/SVG), or external URL */
  data: string;
  /** Alt text for accessibility */
  alt?: string;
}

/**
 * Widget state structure following ChatGPT Apps format.
 * Used for persisting UI state and sharing data with the AI model.
 */
export interface WidgetState {
  /** Content visible to the AI model on follow-up turns */
  modelContent?: string | Record<string, unknown> | null;
  /** UI-only state hidden from model */
  privateContent?: Record<string, unknown> | null;
  /** File IDs for images the model can see */
  imageIds?: string[];
}
