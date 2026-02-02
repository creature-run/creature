/**
 * Content Security Policy (CSP) utilities for MCP Apps.
 *
 * Constructs and injects CSP meta tags into HTML content
 * per the MCP Apps specification.
 */

/**
 * CSP configuration from MCP resource metadata.
 */
export interface CspConfig {
  connectDomains?: string[];
  resourceDomains?: string[];
}

/**
 * Check if HTML contains the Creature HMR client script.
 */
export const hasHmrClient = (html: string): boolean => {
  return html.includes("__CREATURE_HMR_CONNECTED__");
};

/**
 * Build Content Security Policy string from CSP config.
 *
 * Constructs a restrictive CSP with optional connect and resource domains.
 * resourceDomains are also included in script-src to support dev server scripts.
 * worker-src allows blob: for libraries like Monaco Editor that use web workers.
 */
export const buildCSP = (csp?: CspConfig, options?: { allowHmr?: boolean }): string => {
  const filterAndJoin = (arr?: string[]): string => {
    if (!arr || !Array.isArray(arr)) return "";
    return arr
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join(" ");
  };

  let connectDomains = filterAndJoin(csp?.connectDomains);
  if (options?.allowHmr) {
    connectDomains = `ws://localhost:* ${connectDomains}`.trim();
  }
  const resourceDomains = filterAndJoin(csp?.resourceDomains);

  // Build each directive, trimming extra spaces
  // Note: resourceDomains are included in script-src for dev mode (Vite scripts)
  // worker-src allows blob: for Monaco Editor web workers and resourceDomains for CDN workers
  const directives = [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:${resourceDomains ? ` ${resourceDomains}` : ""}`,
    `style-src 'self' 'unsafe-inline'${resourceDomains ? ` ${resourceDomains}` : ""}`,
    `connect-src 'self'${connectDomains ? ` ${connectDomains}` : ""}`,
    `img-src 'self' data:${resourceDomains ? ` ${resourceDomains}` : ""}`,
    `font-src 'self' data:${resourceDomains ? ` ${resourceDomains}` : ""}`,
    `media-src 'self' data:${resourceDomains ? ` ${resourceDomains}` : ""}`,
    `worker-src 'self' blob:${resourceDomains ? ` ${resourceDomains}` : ""}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ];

  // Filter out any undefined directives (defensive)
  return directives.filter((d) => typeof d === "string" && !d.includes("undefined")).join("; ");
};

/**
 * Inject CSP meta tag into HTML content before rendering.
 */
export const injectCSP = ({
  html,
  csp,
}: {
  html: string;
  csp?: CspConfig;
}): string => {
  const allowHmr = hasHmrClient(html);
  const cspValue = buildCSP(csp, { allowHmr });
  const metaTag = `<meta http-equiv="Content-Security-Policy" content="${cspValue}">`;

  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>${metaTag}`);
  } else if (html.includes("<html>")) {
    return html.replace("<html>", `<html><head>${metaTag}</head>`);
  } else {
    return metaTag + html;
  }
};

