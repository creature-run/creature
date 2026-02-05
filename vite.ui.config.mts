import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { resolve } from "path";

/**
 * Vite config for built-in MCP UIs.
 *
 * Builds each UI as a single self-contained HTML file with all JS/CSS inlined.
 * This is required because MCP App UIs are served as HTML strings in iframes,
 * which can't load external assets.
 *
 * Set MCP_UI env var to specify which UI to build:
 *   MCP_UI=browser vite build --config vite.ui.config.mts
 *
 * Output locations:
 * - dist/browser/ui/index.html  (Browser MCP UI)
 * - dist/terminal/ui/index.html (Terminal MCP UI)
 * - dist/ide/ui/index.html      (IDE MCP UI)
 * - dist/todos/ui/index.html    (Todos MCP UI)
 * - dist/notes/ui/index.html    (Notes MCP UI)
 * - dist/crm/ui/index.html      (CRM MCP UI)
 *
 * IMPORTANT: The open-mcp-app SDK marks React as external (correct for library use).
 * However, for single-file builds, React MUST be bundled. We use resolve.dedupe
 * to ensure a single React instance is bundled, avoiding the "useState is null" error.
 */
const mcpName = process.env.MCP_UI || "browser";
const srcRoot = resolve(__dirname, `src/electron/mcps/${mcpName}/ui`);
const outDir = resolve(__dirname, `dist/${mcpName}/ui`);

export default defineConfig({
  root: srcRoot,
  plugins: [react(), tailwindcss(), viteSingleFile()],
  base: "./",
  resolve: {
    // Force all React imports to use the same instance.
    // Prevents "Invalid hook call" errors when the SDK has React externalized.
    dedupe: ["react", "react-dom"],
    alias: {
      // Ensure React resolves to local node_modules
      react: resolve(__dirname, "node_modules/react"),
      "react-dom": resolve(__dirname, "node_modules/react-dom"),
    },
  },
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: {
      // Force React to be bundled, not treated as external
      // This is needed because open-mcp-app SDK marks React as external
      external: [],
    },
  },
});
