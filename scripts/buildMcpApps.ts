/**
 * Cross-platform build script for MCP Apps.
 *
 * This script builds the MCP apps (notes, todos, crm) with two modes:
 *
 * Development (default):
 *   - Only installs dependencies if node_modules is missing
 *   - Only rebuilds if source files have changed
 *   - Uses local SDK via file: reference (symlinks are fine for dev)
 *   - Builds apps in parallel for speed
 *
 * Production (--production flag):
 *   - Clean install with published SDK version (no symlinks)
 *   - Required for packaging since symlinks break code signing
 *   - Builds apps sequentially to avoid npm cache conflicts
 *
 * Usage:
 *   npx tsx scripts/buildMcpApps.ts              # Dev build all apps (parallel)
 *   npx tsx scripts/buildMcpApps.ts notes        # Dev build single app
 *   npx tsx scripts/buildMcpApps.ts --production # Production build all apps
 */

import * as fs from "fs";
import * as path from "path";
import { execSync, spawn } from "child_process";

const MCP_APPS = ["notes", "todos", "crm"];
const LOCAL_SDK_PATH = "file:../../../../artifacts/sdk";
const PUBLISHED_SDK_VERSION = "^0.0.5";

interface PackageJson {
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Returns the absolute path to an MCP app directory.
 */
const getAppDir = (appName: string): string => {
  return path.join(__dirname, "..", "src", "electron", "mcps", appName);
};

/**
 * Reads and parses the package.json file from the given app directory.
 */
const readPackageJson = (appDir: string): PackageJson => {
  const pkgPath = path.join(appDir, "package.json");
  return JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
};

/**
 * Writes the package.json file to the given app directory.
 */
const writePackageJson = (appDir: string, pkg: PackageJson): void => {
  const pkgPath = path.join(appDir, "package.json");
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
};

/**
 * Recursively removes a directory if it exists.
 */
const removeDir = (dir: string): void => {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * Removes a file if it exists.
 */
const removeFile = (filePath: string): void => {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
};

/**
 * Gets the most recent modification time of all files in a directory recursively.
 * Returns 0 if directory doesn't exist.
 */
const getNewestMtime = (dir: string): number => {
  if (!fs.existsSync(dir)) return 0;

  let newest = 0;
  const walk = (currentDir: string) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules and dist directories
        if (entry.name !== "node_modules" && entry.name !== "dist") {
          walk(fullPath);
        }
      } else {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs > newest) {
          newest = stat.mtimeMs;
        }
      }
    }
  };
  walk(dir);
  return newest;
};

/**
 * Checks if dependencies need to be installed.
 * Returns true if node_modules is missing or package.json is newer.
 */
const needsInstall = (appDir: string): boolean => {
  const nodeModulesPath = path.join(appDir, "node_modules");
  if (!fs.existsSync(nodeModulesPath)) {
    return true;
  }

  const pkgPath = path.join(appDir, "package.json");
  const pkgMtime = fs.statSync(pkgPath).mtimeMs;
  const nodeModulesMtime = fs.statSync(nodeModulesPath).mtimeMs;

  return pkgMtime > nodeModulesMtime;
};

/**
 * Checks if the app needs to be rebuilt.
 * Returns true if dist/ is missing or src/ has newer files.
 */
const needsBuild = (appDir: string): boolean => {
  const distDir = path.join(appDir, "dist");
  if (!fs.existsSync(distDir)) {
    return true;
  }

  const srcDir = path.join(appDir, "src");
  const srcMtime = getNewestMtime(srcDir);
  const distMtime = getNewestMtime(distDir);

  return srcMtime > distMtime;
};

/**
 * Builds a single MCP app in development mode.
 * Only installs and builds if necessary.
 */
const buildAppDev = (appName: string): void => {
  const appDir = getAppDir(appName);

  if (!fs.existsSync(appDir)) {
    console.error(`[buildMcpApps] App directory not found: ${appDir}`);
    process.exit(1);
  }

  // Check if install is needed
  if (needsInstall(appDir)) {
    console.log(`[buildMcpApps] Installing dependencies for ${appName}...`);
    execSync("npm install", {
      cwd: appDir,
      stdio: "inherit",
    });
  } else {
    console.log(`[buildMcpApps] Dependencies up-to-date for ${appName}`);
  }

  // Check if build is needed
  if (needsBuild(appDir)) {
    console.log(`[buildMcpApps] Building ${appName}...`);
    execSync("npm run build", {
      cwd: appDir,
      stdio: "inherit",
    });
    console.log(`[buildMcpApps] Successfully built ${appName}`);
  } else {
    console.log(`[buildMcpApps] ${appName} is up-to-date, skipping build`);
  }
};

/**
 * Builds a single MCP app in production mode.
 * Clean install with published SDK (no symlinks) for packaging.
 */
const buildAppProduction = (appName: string): void => {
  const appDir = getAppDir(appName);

  if (!fs.existsSync(appDir)) {
    console.error(`[buildMcpApps] App directory not found: ${appDir}`);
    process.exit(1);
  }

  console.log(`[buildMcpApps] Production build for ${appName}...`);

  // Read original package.json to restore later
  const pkg = readPackageJson(appDir);
  const originalSdkVersion = pkg.dependencies?.["open-mcp-app"];

  try {
    // Clean everything for a fresh production build
    console.log(`[buildMcpApps] Cleaning ${appName}...`);
    removeDir(path.join(appDir, "node_modules"));
    removeFile(path.join(appDir, "package-lock.json"));
    removeDir(path.join(appDir, "dist"));

    // Temporarily update package.json to use published SDK
    // This ensures node_modules contains actual packages, not symlinks
    if (pkg.dependencies) {
      pkg.dependencies["open-mcp-app"] = PUBLISHED_SDK_VERSION;
      writePackageJson(appDir, pkg);
    }

    // Install production dependencies only (no devDeps needed for runtime)
    console.log(`[buildMcpApps] Installing production dependencies for ${appName}...`);
    execSync("npm install --omit=dev", {
      cwd: appDir,
      stdio: "inherit",
    });

    // Now install all deps to build (need devDeps for build tools)
    console.log(`[buildMcpApps] Installing build dependencies for ${appName}...`);
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

    // Clean out devDependencies, keeping only production deps
    console.log(`[buildMcpApps] Cleaning devDependencies for ${appName}...`);
    removeDir(path.join(appDir, "node_modules"));
    removeFile(path.join(appDir, "package-lock.json"));
    execSync("npm install --omit=dev", {
      cwd: appDir,
      stdio: "inherit",
    });

    console.log(`[buildMcpApps] Successfully built ${appName} for production`);
  } finally {
    // Restore original package.json with local SDK reference
    // This keeps the git working tree clean
    if (pkg.dependencies && originalSdkVersion) {
      pkg.dependencies["open-mcp-app"] = originalSdkVersion;
      writePackageJson(appDir, pkg);
    }
  }
};

/**
 * Builds all apps in parallel (development mode).
 * Uses Promise.all to run builds concurrently.
 */
const buildAllAppsDev = async (): Promise<void> => {
  console.log(`[buildMcpApps] Building all apps in parallel (dev mode)...`);

  const buildPromises = MCP_APPS.map((appName) => {
    return new Promise<void>((resolve, reject) => {
      const child = spawn("npx", ["tsx", __filename, appName], {
        stdio: "inherit",
        shell: true,
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Build failed for ${appName} with code ${code}`));
        }
      });
      child.on("error", reject);
    });
  });

  await Promise.all(buildPromises);
  console.log(`[buildMcpApps] All apps built successfully`);
};

/**
 * Builds all apps sequentially (production mode).
 * Sequential to avoid npm cache conflicts during clean installs.
 */
const buildAllAppsProduction = (): void => {
  console.log(`[buildMcpApps] Building all apps sequentially (production mode)...`);
  for (const appName of MCP_APPS) {
    buildAppProduction(appName);
  }
  console.log(`[buildMcpApps] All apps built successfully for production`);
};

// Main entry point
const main = async () => {
  const args = process.argv.slice(2);
  const isProduction = args.includes("--production");
  const appArg = args.find((arg) => !arg.startsWith("--"));

  if (appArg) {
    // Single app build
    if (!MCP_APPS.includes(appArg)) {
      console.error(`[buildMcpApps] Unknown app: ${appArg}`);
      console.error(`[buildMcpApps] Available apps: ${MCP_APPS.join(", ")}`);
      process.exit(1);
    }

    if (isProduction) {
      buildAppProduction(appArg);
    } else {
      buildAppDev(appArg);
    }
  } else {
    // Build all apps
    if (isProduction) {
      buildAllAppsProduction();
    } else {
      await buildAllAppsDev();
    }
  }
};

main().catch((err) => {
  console.error(`[buildMcpApps] Error:`, err);
  process.exit(1);
});
