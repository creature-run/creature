/**
 * Console Capture Utilities for UI Resources
 *
 * Injects a console override script into MCP App HTML to capture
 * console.* calls and forward them to the Host for centralized logging.
 */

import { CONSOLE_OVERRIDE_SCRIPT } from "../logging";

/**
 * Inject the console override script into HTML content.
 * The script is injected after the <head> tag so it runs before app scripts.
 *
 * @param html - The HTML content to inject into
 * @returns The HTML with console override script injected
 */
export const injectConsoleOverride = ({ html }: { html: string }): string => {
  // Guard against undefined script (module resolution issue)
  if (!CONSOLE_OVERRIDE_SCRIPT) {
    console.warn("[ConsoleCapture] CONSOLE_OVERRIDE_SCRIPT is undefined, skipping injection");
    return html;
  }

  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>${CONSOLE_OVERRIDE_SCRIPT}`);
  } else if (html.includes("<html>")) {
    return html.replace("<html>", `<html><head>${CONSOLE_OVERRIDE_SCRIPT}</head>`);
  } else {
    return CONSOLE_OVERRIDE_SCRIPT + html;
  }
};

