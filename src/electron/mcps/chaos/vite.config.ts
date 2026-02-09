import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { creature } from "open-mcp-app/vite";
import { renameSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const MCP_NAME = "chaos";

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
    const outDir = resolve(__dirname, `dist/${MCP_NAME}/ui`);
    const mainPath = resolve(outDir, "main.html");
    const indexPath = resolve(outDir, "index.html");
    if (existsSync(mainPath)) {
      renameSync(mainPath, indexPath);
    }
  },
});

/**
 * Vite config for Chaos MCP.
 *
 * Development mode:
 * - Uses Vite build --watch to rebuild UI HTML on change
 * - No singlefile inlining (faster incremental rebuilds)
 *
 * Production mode:
 * - Uses vite-plugin-singlefile to inline all JS/CSS into the HTML file
 * - Required because MCP App UIs are served as HTML strings in iframes
 *
 * Output path matches production structure: dist/{mcpName}/ui/index.html
 */
export default defineConfig(({ mode }) => {
  const isProduction = mode === "production";

  return {
    plugins: [
      react(),
      ...(isProduction ? [viteSingleFile()] : []),
      creature({ uiDir: "ui", outDir: `dist/${MCP_NAME}/ui` }),
      ...(isProduction ? [renameToIndex()] : []),
    ],
    resolve: {
      dedupe: ["react", "react-dom"],
    },
  };
});
