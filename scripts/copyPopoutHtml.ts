/**
 * Cross-platform script to copy popout HTML files after Vite build.
 *
 * Usage: npx tsx scripts/copyPopoutHtml.ts
 */

import * as fs from "fs";
import * as path from "path";

const srcDir = path.join(__dirname, "..", "src", "assets", "popouts");
const destDir = path.join(__dirname, "..", "dist", "assets", "popouts");

// Ensure destination directory exists
fs.mkdirSync(destDir, { recursive: true });

// Copy all .html files
const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".html"));

for (const file of files) {
  const srcPath = path.join(srcDir, file);
  const destPath = path.join(destDir, file);
  fs.copyFileSync(srcPath, destPath);
  console.log(`[copyPopoutHtml] Copied ${file}`);
}

console.log(`[copyPopoutHtml] Done - copied ${files.length} file(s)`);
