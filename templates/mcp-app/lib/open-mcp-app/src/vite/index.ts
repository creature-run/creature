import { resolve, join, relative } from "node:path";
import { readdirSync, statSync, existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { Plugin, UserConfig } from "vite";

export interface CreaturePluginOptions {
  uiDir?: string;
  outDir?: string;
  /**
   * Generate a JS module exporting bundled HTML for serverless deployments.
   * When enabled, creates `dist/ui/bundle.js` with named exports for each page.
   * 
   * @example
   * // In server code:
   * import { main } from "./dist/ui/bundle.js";
   * app.resource({ html: main });
   * 
   * @default false
   */
  generateBundle?: boolean;
}

interface EntryPoint {
  name: string;
  pagePath: string;
}

function findPages(dir: string, baseDir: string): EntryPoint[] {
  const entries: EntryPoint[] = [];
  if (!existsSync(dir)) return entries;

  const items = readdirSync(dir);

  if (items.includes("app.tsx")) {
    const relativePath = dir.slice(baseDir.length + 1);
    entries.push({
      name: relativePath || "main",
      pagePath: join(dir, "app.tsx"),
    });
  }

  for (const item of items) {
    const fullPath = join(dir, item);
    if (statSync(fullPath).isDirectory() && !item.startsWith("_") && item !== "node_modules") {
      entries.push(...findPages(fullPath, baseDir));
    }
  }

  return entries;
}

/**
 * Log a UI rebuild completion message for dev watch mode.
 */
function notifyUiReload(): void {
  console.log("App UI reloaded");
}

/**
 * Vite plugin for Creature MCP Apps.
 * 
 * Just write app.tsx files - no HTML or entry files needed.
 * 
 * ```
 * src/ui/
 * ├── app.tsx         → dist/ui/main.html
 * ├── inline/app.tsx  → dist/ui/inline.html
 * └── _components/    → ignored
 * ```
 * 
 * When using vite-plugin-singlefile, multiple pages are built automatically
 * via sequential builds (singlefile requires single entry per build).
 */
export function creature(options: CreaturePluginOptions = {}): Plugin {
  const uiDir = options.uiDir || "src/ui";
  const outDir = options.outDir || "dist/ui";
  const generateBundle = options.generateBundle || false;
  
  let root: string;
  let tempDir: string;
  let entries: EntryPoint[] = [];
  let hasSingleFilePlugin = false;
  let isWatchMode = false;
  let remainingPages: string[] = [];

  return {
    name: "creature",
    
    async config(config) {
      root = config.root || process.cwd();
      const uiPath = resolve(root, uiDir);
      entries = findPages(uiPath, uiPath);

      if (entries.length === 0) {
        return;
      }

      const plugins = config.plugins?.flat() || [];
      hasSingleFilePlugin = plugins.some(p => p && typeof p === 'object' && 'name' in p && p.name === 'vite:singlefile');

      tempDir = resolve(root, "node_modules/.creature");
      
      const selectedPage = process.env.CREATURE_PAGE;
      
      if (!selectedPage) {
        rmSync(tempDir, { recursive: true, force: true });
      }
      mkdirSync(tempDir, { recursive: true });

      for (const entry of entries) {
        const relativePagePath = relative(tempDir, entry.pagePath).replace(/\\/g, "/");
        writeFileSync(join(tempDir, `${entry.name}.entry.tsx`), 
`import { createElement } from "react";
import { createRoot } from "react-dom/client";
import Page from "${relativePagePath.replace(/\.tsx$/, "")}";
createRoot(document.getElementById("root")!).render(createElement(Page));
`);

        writeFileSync(join(tempDir, `${entry.name}.html`),
`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${entry.name}</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./${entry.name}.entry.tsx"></script>
</body>
</html>`);
      }
      
      let inputs: Record<string, string>;
      
      if (hasSingleFilePlugin) {
        const targetEntry = selectedPage 
          ? entries.find(e => e.name === selectedPage)
          : entries[0];
          
        if (!targetEntry) {
          console.error(`Page "${selectedPage}" not found`);
          return;
        }
        
        inputs = { [targetEntry.name]: join(tempDir, `${targetEntry.name}.html`) };
        
        if (!selectedPage && entries.length > 1) {
          remainingPages = entries.slice(1).map(e => e.name);
        }
      } else {
        inputs = Object.fromEntries(
          entries.map(e => [e.name, join(tempDir, `${e.name}.html`)])
        );
      }

      return {
        root: tempDir,
        publicDir: false,
        logLevel: "silent" as const,
        build: {
          outDir: resolve(root, outDir),
          emptyOutDir: !selectedPage,
          rollupOptions: { input: inputs },
          reportCompressedSize: false,
        },
      } satisfies UserConfig;
    },

    async buildStart() {
      if (!tempDir) return;

      isWatchMode = this.meta.watchMode === true;
    },

    writeBundle() {
      if (!hasSingleFilePlugin || remainingPages.length === 0) {
        if (isWatchMode) notifyUiReload();
        return;
      }
      
      for (const pageName of remainingPages) {
        spawnSync("npx", ["vite", "build"], {
          cwd: root,
          env: { ...process.env, CREATURE_PAGE: pageName },
          stdio: "inherit",
        });
      }
      
      if (isWatchMode) {
        notifyUiReload();
      } else {
        remainingPages = [];
      }
    },

    closeBundle() {
      if (isWatchMode) return;
      
      // Generate bundle.js for serverless deployments
      if (generateBundle && entries.length > 0 && !process.env.CREATURE_PAGE) {
        const bundleOutputDir = resolve(root, outDir);
        const exports: string[] = [];
        
        for (const entry of entries) {
          const htmlPath = join(bundleOutputDir, `${entry.name}.html`);
          if (existsSync(htmlPath)) {
            const html = readFileSync(htmlPath, "utf-8");
            // Escape backticks and ${} for template literal
            const escaped = html.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
            exports.push(`export const ${entry.name.replace(/-/g, "_")} = \`${escaped}\`;`);
          }
        }
        
        if (exports.length > 0) {
          const bundleContent = `/**
 * Auto-generated UI bundle for serverless deployments.
 * Import these exports in your MCP server for Vercel/Lambda.
 * 
 * @example
 * import { main } from "./dist/ui/bundle.js";
 * app.resource({ html: main });
 */
${exports.join("\n\n")}
`;
          writeFileSync(join(bundleOutputDir, "bundle.js"), bundleContent);
          console.log(`Generated ${outDir}/bundle.js for serverless`);
        }
      }
      
      if (tempDir && existsSync(tempDir) && !process.env.CREATURE_PAGE) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  };
}

export default creature;
