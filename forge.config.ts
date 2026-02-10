import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerAppImage } from '@reforged/maker-appimage';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import path from 'path';
import fs from 'fs';
import { getBuildIdentity } from './appIdentity';

/**
 * Recursively remove all .bin directories and broken symlinks from node_modules.
 * This is required for macOS code signing - symlinks that point to invalid
 * destinations (outside the app bundle) cause codesign to fail.
 */
const cleanNodeModulesForSigning = (nodeModulesPath: string): void => {
  let binDirsRemoved = 0;
  let symlinksRemoved = 0;

  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      // Remove any .bin directory
      if (entry.isDirectory() && entry.name === '.bin') {
        fs.rmSync(fullPath, { recursive: true, force: true });
        binDirsRemoved++;
        continue;
      }
      
      // Check for symlinks - remove if broken or pointing outside node_modules
      if (entry.isSymbolicLink()) {
        try {
          const linkTarget = fs.readlinkSync(fullPath);
          const resolvedTarget = path.resolve(path.dirname(fullPath), linkTarget);
          
          // Remove if symlink points outside the node_modules directory
          // or if the target doesn't exist (broken symlink)
          if (!resolvedTarget.startsWith(nodeModulesPath) || !fs.existsSync(resolvedTarget)) {
            fs.rmSync(fullPath, { force: true });
            symlinksRemoved++;
          }
        } catch {
          // If we can't read the symlink, remove it
          fs.rmSync(fullPath, { force: true });
          symlinksRemoved++;
        }
        continue;
      }
      
      // Recurse into subdirectories (including nested node_modules)
      if (entry.isDirectory()) {
        walk(fullPath);
      }
    }
  };

  walk(nodeModulesPath);
  
  if (binDirsRemoved > 0) {
    console.log(`[Forge] Removed ${binDirsRemoved} .bin directories (symlinks break codesign)`);
  }
  if (symlinksRemoved > 0) {
    console.log(`[Forge] Removed ${symlinksRemoved} broken/external symlinks`);
  }
};

// Import Windows signing config if available (only on Windows CI with Azure Trusted Signing)
import { windowsSign } from './windowsSign';

/**
 * Copy MCP UI bundles to resources for packaged app.
 * UIs are built to dist/{name}/ui/ as single-file HTML.
 */
const copyMcpUIs = (resourcesPath: string) => {
  const distDir = path.join(__dirname, 'dist');
  const destDir = path.join(resourcesPath, 'mcp-uis');

  // Copy all MCP UIs
  const mcpNames = ['browser', 'terminal', 'ide', 'todos', 'notes', 'crm', 'devkit'];
  for (const name of mcpNames) {
    const srcPath = path.join(distDir, name, 'ui');
    const destPath = path.join(destDir, name, 'ui');
    if (fs.existsSync(srcPath)) {
      fs.mkdirSync(destPath, { recursive: true });
      fs.cpSync(srcPath, destPath, { recursive: true });
      console.log(`[Forge] Copied ${name} UI to resources`);
    } else {
      console.warn(`[Forge] Warning: ${name} UI not found at ${srcPath}. Run build first.`);
    }
  }

  // Copy popout assets
  const popoutSrc = path.join(distDir, 'assets', 'popouts');
  const popoutDest = path.join(destDir, 'assets', 'popouts');
  if (fs.existsSync(popoutSrc)) {
    fs.mkdirSync(popoutDest, { recursive: true });
    fs.cpSync(popoutSrc, popoutDest, { recursive: true });
    console.log('[Forge] Copied popout assets to resources');
  }
};

/**
 * Copy the MCP app template to Resources/mcp-app-template/.
 * This template is used by the dev-mcp project profile to scaffold
 * new MCP App projects. Without it, project creation fails in packaged builds
 * because findTemplatePath() looks for the template in process.resourcesPath.
 */
const copyMcpAppTemplate = (resourcesPath: string) => {
  const srcDir = path.join(__dirname, 'templates', 'mcp-app');
  const destDir = path.join(resourcesPath, 'mcp-app-template');

  if (fs.existsSync(srcDir)) {
    fs.mkdirSync(destDir, { recursive: true });
    fs.cpSync(srcDir, destDir, { recursive: true });
    console.log('[Forge] Copied MCP app template to resources');
  } else {
    console.warn(`[Forge] Warning: MCP app template not found at ${srcDir}`);
  }
};

/**
 * Copy the standalone Node.js binary to Resources/bin/.
 * 
 * We bundle a real Node.js binary (not Electron) to avoid macOS showing
 * dock icons when npm spawns child processes. On macOS, any executable
 * inside a .app bundle shows in the dock, even with ELECTRON_RUN_AS_NODE=1.
 * 
 * The Node.js binary must be downloaded before packaging. Run:
 *   npm run download:node
 * 
 * This downloads the appropriate Node.js binary for the current platform
 * to artifacts/node-binary/
 */
const copyNodeBinary = (resourcesPath: string) => {
  const binDir = path.join(resourcesPath, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  // Source: downloaded Node.js binary in artifacts/node-binary/
  const nodeBinaryDir = path.join(__dirname, 'artifacts', 'node-binary');
  const isWindows = process.platform === 'win32';
  const nodeExeName = isWindows ? 'node.exe' : 'node';
  const srcNodeBinary = path.join(nodeBinaryDir, nodeExeName);

  if (!fs.existsSync(srcNodeBinary)) {
    console.error(`[Forge] ERROR: Node.js binary not found at ${srcNodeBinary}`);
    console.error('[Forge] Run "npm run download:node" before packaging');
    throw new Error('Node.js binary not found. Run "npm run download:node" first.');
  }

  // Copy node binary
  const destNodeBinary = path.join(binDir, nodeExeName);
  fs.copyFileSync(srcNodeBinary, destNodeBinary);
  if (!isWindows) {
    fs.chmodSync(destNodeBinary, 0o755);
  }
  console.log('[Forge] Copied Node.js binary to resources');

  // Create npm/npx wrapper scripts that use the bundled node
  if (isWindows) {
    const npmCmd = path.join(binDir, 'npm.cmd');
    fs.writeFileSync(npmCmd, `@echo off\r\n"%~dp0node.exe" "%~dp0..\\npm\\bin\\npm-cli.js" %*\r\n`);
    
    const npxCmd = path.join(binDir, 'npx.cmd');
    fs.writeFileSync(npxCmd, `@echo off\r\n"%~dp0node.exe" "%~dp0..\\npm\\bin\\npx-cli.js" %*\r\n`);
    
    console.log('[Forge] Created npm/npx wrappers for Windows');
  } else {
    const npmScript = path.join(binDir, 'npm');
    fs.writeFileSync(npmScript, `#!/bin/bash
"$(dirname "$0")/node" "$(dirname "$0")/../npm/bin/npm-cli.js" "$@"
`, { mode: 0o755 });

    const npxScript = path.join(binDir, 'npx');
    fs.writeFileSync(npxScript, `#!/bin/bash
"$(dirname "$0")/node" "$(dirname "$0")/../npm/bin/npx-cli.js" "$@"
`, { mode: 0o755 });

    console.log('[Forge] Created npm/npx wrapper scripts');
  }
};

/**
 * Copy bundled npm for running npm/npx commands in packaged app.
 * 
 * Electron bundles Node.js but not npm. To make the app self-contained
 * (not requiring users to have Node/npm installed), we bundle npm
 * and run it using Electron's Node via process.execPath.
 */
const copyBundledNpm = (resourcesPath: string) => {
  const destDir = path.join(resourcesPath, 'npm');

  // Try desktop/node_modules first, then root node_modules
  const nodeModulesLocations = [
    path.join(__dirname, 'node_modules'),
    path.join(__dirname, '..', 'node_modules'),
  ];

  let npmSrc: string | null = null;
  for (const nodeModules of nodeModulesLocations) {
    const candidate = path.join(nodeModules, 'npm');
    if (fs.existsSync(candidate)) {
      npmSrc = candidate;
      break;
    }
  }

  if (npmSrc) {
    fs.mkdirSync(destDir, { recursive: true });
    fs.cpSync(npmSrc, destDir, { recursive: true });
    
    // Clean npm's node_modules for signing (remove .bin and broken symlinks)
    const npmNodeModules = path.join(destDir, 'node_modules');
    if (fs.existsSync(npmNodeModules)) {
      cleanNodeModulesForSigning(npmNodeModules);
    }
    
    console.log('[Forge] Bundled npm for self-contained app');
  } else {
    console.warn('[Forge] Warning: npm not found in node_modules - app will require system npm');
  }
};

/**
 * Copy native dependencies for MCP servers.
 * 
 * MCP servers are bundled by Vite with native modules externalized.
 * We copy native modules to Resources/native-deps/node_modules/ so
 * they can be found via NODE_PATH when spawning MCP servers.
 * 
 * Important: We only copy prebuilds for the current platform to avoid
 * code signing issues (e.g., Windows signtool can't sign macOS binaries).
 */
const copyNativeDeps = (resourcesPath: string) => {
  const destDir = path.join(resourcesPath, 'native-deps', 'node_modules');
  
  // Native modules to copy (relative to node_modules)
  // Note: chokidar is bundled by Vite (only fsevents is external)
  const nativeModules = [
    'node-pty',           // Terminal MCP - PTY support
    '@vscode/ripgrep',    // IDE MCP - fast file search
  ];

  // Try desktop/node_modules first, then root node_modules
  const nodeModulesLocations = [
    path.join(__dirname, 'node_modules'),
    path.join(__dirname, '..', 'node_modules'),
  ];

  // Determine current platform prefix for prebuilds (e.g., 'darwin', 'win32', 'linux')
  const currentPlatform = process.platform;

  for (const moduleName of nativeModules) {
    let src: string | null = null;
    for (const nodeModules of nodeModulesLocations) {
      const candidate = path.join(nodeModules, moduleName);
      if (fs.existsSync(candidate)) {
        src = candidate;
        break;
      }
    }

    if (src) {
      const dest = path.join(destDir, moduleName);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
      
      // Remove prebuilds for other platforms to avoid code signing issues
      // (e.g., Windows signtool can't sign macOS .node files)
      const prebuildsDir = path.join(dest, 'prebuilds');
      if (fs.existsSync(prebuildsDir)) {
        const entries = fs.readdirSync(prebuildsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith(currentPlatform)) {
            const otherPlatformDir = path.join(prebuildsDir, entry.name);
            fs.rmSync(otherPlatformDir, { recursive: true, force: true });
            console.log(`[Forge] Removed non-${currentPlatform} prebuild: ${entry.name}`);
          }
        }
      }
      
      console.log(`[Forge] Copied ${moduleName} to resources`);
    } else {
      console.warn(`[Forge] Warning: ${moduleName} not found`);
    }
  }
};

/**
 * Generate app-update.yml for the auto-updater.
 * 
 * The URL is dynamically set based on the current platform and architecture
 * so each platform build points to its own S3 folder.
 * 
 * Maps:
 * - darwin/arm64 -> darwin/arm64
 * - win32/x64 -> win32/x64
 * - linux/x64 -> linux/x64
 */
const generateAppUpdateConfig = (resourcesPath: string) => {
  if (buildIdentity.variant !== 'prod') {
    console.log('[Forge] Skipping app-update.yml for non-prod build');
    return;
  }

  const platform = process.platform;
  const arch = process.arch;
  
  const updateUrl = `https://releases.creature.run/desktop/${platform}/${arch}`;
  
  const appUpdateYml = `provider: generic
url: ${updateUrl}
updaterCacheDirName: ${buildIdentity.updaterCacheDirName}
`;

  const destPath = path.join(resourcesPath, 'app-update.yml');
  fs.writeFileSync(destPath, appUpdateYml, 'utf-8');
  console.log(`[Forge] Generated app-update.yml for ${platform}/${arch} -> ${updateUrl}`);
};

/**
 * Check if Apple signing credentials are available.
 */
const hasAppleCredentials = !!(
  process.env.APPLE_ID &&
  process.env.APPLE_PASSWORD &&
  process.env.APPLE_TEAM_ID
);

const buildIdentity = getBuildIdentity();
const localDmgNameOverride = process.env.CREATURE_DMG_NAME?.trim();

if (localDmgNameOverride) {
  console.log(`[Forge] Using custom DMG name override: ${localDmgNameOverride}`);
}

if (hasAppleCredentials) {
  console.log('[Forge] Apple credentials detected - signing enabled');
} else {
  console.log('[Forge] No Apple credentials - building unsigned');
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: buildIdentity.packagerName,
    executableName: buildIdentity.executableName,
    icon: path.join(__dirname, 'icons', 'icon'),
    appBundleId: buildIdentity.bundleId,
    appCategoryType: 'public.app-category.developer-tools',

    // Note: app-update.yml is generated dynamically in packageAfterCopy hook
    // based on the platform/arch to point to the correct S3 folder

    // Allow localhost connections for the auto-updater proxy server (Squirrel.Mac)
    extendInfo: {
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
      },
    },

    // macOS code signing and notarization
    ...(hasAppleCredentials && {
      osxSign: {
        // Use explicit identity from env var, or fall back to auto-detection
        ...(process.env.APPLE_IDENTITY && { identity: process.env.APPLE_IDENTITY }),
        optionsForFile: () => ({
          hardenedRuntime: true,
          entitlements: path.join(__dirname, 'entitlements.plist'),
        }),
      },
      osxNotarize: {
        appleId: process.env.APPLE_ID!,
        appleIdPassword: process.env.APPLE_PASSWORD!,
        teamId: process.env.APPLE_TEAM_ID!,
      },
    }),

    // Windows code signing via Azure Trusted Signing
    ...(windowsSign && { windowsSign }),
  },
  rebuildConfig: {},
  hooks: {
    /**
     * Copy MCP assets after packaging.
     * - Node wrapper script for npm postinstall scripts
     * - Bundled npm for self-contained app (no system Node/npm required)
     * - MCP UIs (browser, terminal, ide, todos, notes, crm) as single-file HTML
     * - Native dependencies (@vscode/ripgrep)
     * - Generate platform-specific app-update.yml for auto-updater
     */
    packageAfterCopy: async (_config, buildPath) => {
      const resourcesPath = path.dirname(buildPath);
      console.log('[Forge] Copying MCP assets to', resourcesPath);
      
      copyNodeBinary(resourcesPath);
      copyBundledNpm(resourcesPath);
      copyMcpUIs(resourcesPath);
      copyMcpAppTemplate(resourcesPath);
      copyNativeDeps(resourcesPath);
      generateAppUpdateConfig(resourcesPath);
      
      console.log('[Forge] MCP assets copied successfully');
    },
  },
  makers: [
    new MakerSquirrel({
      name: buildIdentity.squirrelName,
      setupIcon: path.join(__dirname, 'icons', 'icon.ico'),
      iconUrl: 'https://www.creature.run/favicon.ico',
      // Windows code signing via Azure Trusted Signing (passed through from packagerConfig)
      ...(windowsSign && { windowsSign }),
    }),
    new MakerZIP({}, ['darwin']),
    new MakerDMG({
      ...(localDmgNameOverride ? { name: localDmgNameOverride } : {}),
      icon: path.join(__dirname, 'icons', 'icon.icns'),
      format: 'ULFO',
      background: path.join(__dirname, 'icons', 'dmg-background.png'),
      contents: (opts) => [
        { x: 180, y: 200, type: 'file', path: opts.appPath },
        { x: 480, y: 200, type: 'link', path: '/Applications' },
      ],
    }),
    new MakerDeb({
      options: {
        name: buildIdentity.linuxPackageName,
        bin: buildIdentity.linuxBin,
        productName: buildIdentity.appName,
        genericName: 'AI Development Environment',
        description: 'Desktop app for AI agents with rich, interactive components',
        categories: ['Development', 'Utility'],
        icon: path.join(__dirname, 'icons', 'icon.png'),
      },
    }),
    new MakerRpm({
      options: {
        name: buildIdentity.linuxPackageName,
        bin: buildIdentity.linuxBin,
        productName: buildIdentity.appName,
        genericName: 'AI Development Environment',
        description: 'Desktop app for AI agents with rich, interactive components',
        categories: ['Development', 'Utility'],
        icon: path.join(__dirname, 'icons', 'icon.png'),
      },
    }),
    new MakerAppImage({
      options: {
        bin: buildIdentity.linuxBin,
        categories: ['Development', 'Utility'],
        icon: path.join(__dirname, 'icons', 'icon.png'),
      },
    }),
  ],
  plugins: [
    // Automatically unpacks native modules (.node files) from asar
    // Required for node-pty, @vscode/ripgrep, and other native addons
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/electron/main.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/electron/preload.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
        // Built-in MCP servers (run as subprocesses with Electron's Node)
        // Uses same config as main since both are Node targets with same externals
        {
          entry: 'src/electron/mcps/terminal/terminal-server.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/electron/mcps/ide/ide-server.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/electron/mcps/browser/browser-server.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/electron/mcps/todos/todos-server.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/electron/mcps/notes/notes-server.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/electron/mcps/crm/crm-server.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/electron/mcps/devkit/devkit-server.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
