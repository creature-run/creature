/**
 * Panel Icon
 *
 * This file defines the custom icon displayed in the sidebar for the Terminal MCP App.
 *
 * REQUIREMENTS:
 * - Must be an SVG
 * - Must use `currentColor` for stroke and fill (single-color only)
 * - Must be under 10KB
 *
 * The host will style the icon color based on:
 * - Theme (light/dark mode)
 * - Panel visibility (active panels are brighter)
 */

/**
 * The SVG icon content.
 * This is the "terminal-window" icon from Phosphor Icons (regular weight).
 *
 * @see https://phosphoricons.com/
 */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="none"/><polyline points="80 96 120 128 80 160" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><line x1="136" y1="160" x2="176" y2="160" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><rect x="32" y="48" width="192" height="160" rx="8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/></svg>`;

/**
 * Alt text for accessibility.
 */
export const ICON_ALT = "Terminal";

/**
 * Converts the SVG to a base64 data URI for use in resource metadata.
 *
 * @returns Data URI string for the icon
 */
export const getIconDataUri = (): string => {
  const base64 = Buffer.from(ICON_SVG).toString("base64");
  return `data:image/svg+xml;base64,${base64}`;
};
