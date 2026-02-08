/**
 * Style Application Utilities
 *
 * Host-provided spec variables (colors, typography, etc.) are applied automatically
 * when the app initializes via hostContext.styles.variables.
 */

/**
 * Apply CSS variables to an element (defaults to document root).
 *
 * @param styles - Record of CSS variable names to their values
 * @param root - Element to apply styles to (defaults to document.documentElement)
 */
export const applyStyles = ({
  styles,
  root,
}: {
  styles: Record<string, string>;
  root?: HTMLElement;
}): void => {
  if (typeof document === "undefined") {
    return;
  }

  const element = root ?? document.documentElement;
  for (const [key, value] of Object.entries(styles)) {
    element.style.setProperty(key, value);
  }
};
