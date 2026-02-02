/**
 * Panel Icon
 *
 * This file defines the custom icon displayed in the sidebar for this MCP App.
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
 * This is the "browser" icon from Phosphor Icons (regular weight).
 *
 * @see https://phosphoricons.com/
 */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,16V88H40V56Zm0,144H40V104H216v96Z"/></svg>`;

/**
 * Alt text for accessibility.
 */
export const ICON_ALT = "Browser Control";

/**
 * Converts the SVG to a base64 data URI for use in resource metadata.
 *
 * @returns Data URI string for the icon
 */
export const getIconDataUri = (): string => {
  const base64 = Buffer.from(ICON_SVG).toString("base64");
  return `data:image/svg+xml;base64,${base64}`;
};

