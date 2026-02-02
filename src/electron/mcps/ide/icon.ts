/**
 * Panel Icon
 *
 * This file defines the custom icon displayed in the sidebar for the IDE MCP App.
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
 * This is the "brackets-curly" icon from Phosphor Icons (duotone weight).
 * Matches the exact icon used in FileTree.tsx for JSON files.
 *
 * @see https://phosphoricons.com/
 */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="none"/><path d="M240,128c-64,0,0,88-64,88H80c-64,0,0-88-64-88,64,0,0-88,64-88h96C240,40,176,128,240,128Z" fill="currentColor" opacity="0.2"/><path fill="currentColor" d="M43.18,128a29.78,29.78,0,0,1,8,10.26c4.8,9.9,4.8,22,4.8,33.74,0,24.31,1,36,24,36a8,8,0,0,1,0,16c-17.48,0-29.32-6.14-35.2-18.26-4.8-9.9-4.8-22-4.8-33.74,0-24.31-1-36-24-36a8,8,0,0,1,0-16c23,0,24-11.69,24-36,0-11.72,0-23.84,4.8-33.74C50.68,38.14,62.52,32,80,32a8,8,0,0,1,0,16C57,48,56,59.69,56,84c0,11.72,0,23.84-4.8,33.74A29.78,29.78,0,0,1,43.18,128ZM240,120c-23,0-24-11.69-24-36,0-11.72,0-23.84-4.8-33.74C205.32,38.14,193.48,32,176,32a8,8,0,0,0,0,16c23,0,24,11.69,24,36,0,11.72,0,23.84,4.8,33.74a29.78,29.78,0,0,0,8,10.26,29.78,29.78,0,0,0-8,10.26c-4.8,9.9-4.8,22-4.8,33.74,0,24.31-1,36-24,36a8,8,0,0,0,0,16c17.48,0,29.32-6.14,35.2-18.26,4.8-9.9,4.8-22,4.8-33.74,0-24.31,1-36,24-36a8,8,0,0,0,0-16Z"/></svg>`;

/**
 * Alt text for accessibility.
 */
export const ICON_ALT = "Code Editor";

/**
 * Converts the SVG to a base64 data URI for use in resource metadata.
 *
 * @returns Data URI string for the icon
 */
export const getIconDataUri = (): string => {
  const base64 = Buffer.from(ICON_SVG).toString("base64");
  return `data:image/svg+xml;base64,${base64}`;
};

