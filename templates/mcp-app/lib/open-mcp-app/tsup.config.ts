import { defineConfig } from "tsup";
import { mkdirSync, copyFileSync } from "fs";
import { join } from "path";

/**
 * Build configuration for open-mcp-app.
 *
 * Single config to avoid parallel build race conditions.
 * Each subpath has specific bundling requirements handled via esbuild plugins.
 *
 * CSS Strategy:
 * We export SOURCE CSS files (not compiled). Apps import these and process
 * them through their own Tailwind build. This allows Tailwind to scan the
 * app's source files and generate only the utility classes actually used.
 * The @theme definitions map host CSS variables to Tailwind's namespace.
 */
export default defineConfig({
  entry: {
    "server/index": "src/server/index.ts",
    "core/index": "src/core/index.ts",
    "react/index": "src/react/index.ts",
    "vite/index": "src/vite/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  external: ["react", "vite"],
  noExternal: ["@modelcontextprotocol/ext-apps", "@modelcontextprotocol/sdk"],
  esbuildOptions(options, context) {
    // Server entry should externalize deps
    if (context.entryPoints?.includes("src/server/index.ts")) {
      options.external = [
        ...(options.external || []),
        "@modelcontextprotocol/sdk",
        "express",
        "zod",
        "ws",
      ];
    }
  },
  async onSuccess() {
    // Copy CSS source files to dist for apps to process through their Tailwind build
    const cssFiles = ["index.css", "reset.css", "theme.css", "utilities.css"];

    mkdirSync("dist/styles", { recursive: true });

    for (const file of cssFiles) {
      copyFileSync(join("src/styles", file), join("dist/styles", file));
    }

    console.log("CSS source files copied to dist/styles/");
  },
});
