/**
 * Cross-platform build script for MCP Apps.
 *
 * This script builds the MCP apps (notes, todos, crm) by:
 * 1. Temporarily updating package.json to use the local SDK
 * 2. Cleaning and installing dependencies
 * 3. Building the app
 * 4. Restoring package.json to use the published SDK version
 *
 * Usage: npx tsx scripts/buildMcpApps.ts [appName]
 *   If no appName is provided, all apps are built in parallel.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const MCP_APPS = ["notes", "todos", "crm"];
const LOCAL_SDK_PATH = "file:../../sdk";
const PUBLISHED_SDK_VERSION = "^0.0.2";

interface PackageJson {
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

function getAppDir(appName: string): string {
  return path.join(__dirname, "..", "artifacts", "mcp-apps", appName);
}

function readPackageJson(appDir: string): PackageJson {
  const pkgPath = path.join(appDir, "package.json");
  return JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
}

function writePackageJson(appDir: string, pkg: PackageJson): void {
  const pkgPath = path.join(appDir, "package.json");
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
}

function removeDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function removeFile(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function buildApp(appName: string): void {
  const appDir = getAppDir(appName);

  if (!fs.existsSync(appDir)) {
    console.error(`[buildMcpApps] App directory not found: ${appDir}`);
    process.exit(1);
  }

  console.log(`[buildMcpApps] Building ${appName}...`);

  // Read original package.json
  const pkg = readPackageJson(appDir);
  const originalSdkVersion = pkg.dependencies?.["open-mcp-app"];

  try {
    // Clean directories
    console.log(`[buildMcpApps] Cleaning ${appName}...`);
    removeDir(path.join(appDir, "node_modules"));
    removeFile(path.join(appDir, "package-lock.json"));
    removeDir(path.join(appDir, "dist"));

    // Update package.json to use local SDK
    if (pkg.dependencies) {
      pkg.dependencies["open-mcp-app"] = LOCAL_SDK_PATH;
      writePackageJson(appDir, pkg);
    }

    // Install dependencies
    console.log(`[buildMcpApps] Installing dependencies for ${appName}...`);
    execSync("npm install", {
      cwd: appDir,
      stdio: "inherit",
    });

    // Build
    console.log(`[buildMcpApps] Building ${appName}...`);
    execSync("npm run build", {
      cwd: appDir,
      stdio: "inherit",
    });

    console.log(`[buildMcpApps] Successfully built ${appName}`);
  } finally {
    // Restore original package.json (use published version)
    if (pkg.dependencies) {
      pkg.dependencies["open-mcp-app"] =
        originalSdkVersion || PUBLISHED_SDK_VERSION;
      writePackageJson(appDir, pkg);
    }

    // Reinstall with published SDK version so node_modules contains the
    // actual npm package (not a symlink to local SDK) for packaging
    console.log(`[buildMcpApps] Reinstalling ${appName} with published SDK...`);
    removeDir(path.join(appDir, "node_modules"));
    removeFile(path.join(appDir, "package-lock.json"));
    execSync("npm install --production", {
      cwd: appDir,
      stdio: "inherit",
    });
  }
}

async function buildAllApps(): Promise<void> {
  // Build apps sequentially to avoid npm conflicts
  // (parallel builds can cause issues with npm cache)
  for (const appName of MCP_APPS) {
    buildApp(appName);
  }
}

// Main
const appArg = process.argv[2];

if (appArg) {
  if (!MCP_APPS.includes(appArg)) {
    console.error(`[buildMcpApps] Unknown app: ${appArg}`);
    console.error(`[buildMcpApps] Available apps: ${MCP_APPS.join(", ")}`);
    process.exit(1);
  }
  buildApp(appArg);
} else {
  buildAllApps();
}
