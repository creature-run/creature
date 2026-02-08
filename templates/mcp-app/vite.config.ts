import { defineConfig, type Plugin, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { creature } from "open-mcp-app/vite";
import { renameSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Renames main.html to index.html after build.
 *
 * The creature plugin outputs entry points as {name}.html where the default
 * name is "main". Production builds expect index.html, so we rename after build
 * to maintain consistency between dev and production paths.
 */
const renameToIndex = (): Plugin => ({
  name: "rename-to-index",
  closeBundle() {
    const outDir = resolve(__dirname, "dist/ui");
    const mainPath = resolve(outDir, "main.html");
    const indexPath = resolve(outDir, "index.html");
    if (existsSync(mainPath)) {
      renameSync(mainPath, indexPath);
    }
  },
});

/**
 * Vite config for the MCP App UI.
 *
 * Development mode:
 * - Uses standard Vite dev server with HMR for instant updates
 * - No singlefile inlining (allows proper HMR via WebSocket)
 *
 * Production mode:
 * - Uses vite-plugin-singlefile to inline all JS/CSS into the HTML file
 * - This is required because MCP App UIs are served as HTML strings in iframes,
 *   which cannot load external assets in production
 *
 * Tailwind CSS is processed via PostCSS (see postcss.config.js).
 *
 * Output path: dist/ui/index.html
 * This path is name-independent so the agent can freely rename the app
 * without needing to update this config. The server's html path ("ui/index.html")
 * resolves correctly via the SDK's loadHtml function.
 */
export default defineConfig(({ mode }) => {
  const isProduction = mode === "production";

  return {
    plugins: [
      react(),
      ...(isProduction ? [viteSingleFile()] : []),
      creature({ uiDir: "src/ui", outDir: "dist/ui" }),
      ...(isProduction ? [renameToIndex()] : []),
    ] as PluginOption[],
    build: {
      chunkSizeWarningLimit: 1000,
    },
    resolve: {
      dedupe: ["react", "react-dom"],
    },
  };
});
