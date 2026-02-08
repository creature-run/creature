import fs from "node:fs";
import path from "node:path";

export function svgToDataUri(svg: string): string {
  const base64 = Buffer.from(svg).toString("base64");
  return `data:image/svg+xml;base64,${base64}`;
}

/**
 * Find the project root by looking for package.json.
 */
function findProjectRoot(startPath: string): string {
  let current = startPath;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return startPath;
}

/**
 * Load HTML from a file path.
 * Automatically resolves paths like "ui/main.html" to "dist/ui/main.html"
 * regardless of whether running from src/ or dist/.
 */
export function loadHtml(filePath: string, basePath?: string): string {
  const cwdRoot = findProjectRoot(process.cwd());
  const baseRoot = basePath ? findProjectRoot(basePath) : null;
  
  // Search locations in order of priority:
  // 1. cwd project root + dist/ + path (most common: running from project root)
  // 2. basePath project root + dist/ + path (if different from cwd)
  // 3. Relative to basePath directly (for custom setups)
  // 4. Relative to cwd directly
  const searchPaths = [
    path.resolve(cwdRoot, "dist", filePath),
    baseRoot && baseRoot !== cwdRoot ? path.resolve(baseRoot, "dist", filePath) : null,
    basePath ? path.resolve(basePath, filePath) : null,
    path.resolve(process.cwd(), filePath),
  ].filter((p): p is string => p !== null);

  // Deduplicate paths
  const uniquePaths = [...new Set(searchPaths)];

  for (const searchPath of uniquePaths) {
    if (fs.existsSync(searchPath)) {
      return fs.readFileSync(searchPath, "utf-8");
    }
  }

  return `<!DOCTYPE html>
<html><body>
<h1>Error: UI not found</h1>
<p>Run <code>npm run build</code> to build the UI.</p>
</body></html>`;
}

/**
 * Check if a string is HTML content (vs a file path).
 * 
 * HTML content detection:
 * - Starts with `<` (with optional whitespace/BOM)
 * - Starts with `<!DOCTYPE` (case-insensitive)
 * 
 * This enables serverless deployments where HTML is bundled at build time
 * and passed directly as a string, rather than loaded from the filesystem.
 */
export function isHtmlContent(str: string): boolean {
  const trimmed = str.trimStart();
  return trimmed.startsWith("<") || trimmed.toLowerCase().startsWith("<!doctype");
}

/**
 * Create an HTML loader function for a file path or HTML content.
 * 
 * For serverless environments (Vercel, Lambda), developers can:
 * 1. Pass HTML content directly: `html: "<!DOCTYPE html>..."`
 * 2. Use a function: `html: () => BUNDLED_HTML`
 * 3. Import bundled HTML: `html: await import("./ui-bundle.js").then(m => m.HTML)`
 * 
 * The SDK automatically detects whether the string is:
 * - HTML content (starts with `<`) → returns as-is
 * - File path → loads via filesystem (local dev only)
 */
export function htmlLoader(htmlOrPath: string, basePath?: string): () => string {
  // If it's already HTML content, return it directly
  if (isHtmlContent(htmlOrPath)) {
    return () => htmlOrPath;
  }
  // Otherwise, treat as file path and load from filesystem
  return () => loadHtml(htmlOrPath, basePath);
}

/**
 * Safely stringify an object for logging.
 */
export function safeStringify(obj: unknown, maxLength = 500): string {
  try {
    const str = JSON.stringify(obj, null, 2);
    return str.length > maxLength
      ? str.substring(0, maxLength) + "... [truncated]"
      : str;
  } catch {
    return "[Unable to stringify]";
  }
}

/**
 * Check if a request is an MCP initialize request.
 */
export function isInitializeRequest(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const msg = body as Record<string, unknown>;
  return msg.method === "initialize" && msg.jsonrpc === "2.0";
}
