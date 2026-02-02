import { defineConfig } from 'vite';

/**
 * Vite config for Electron main process and MCP servers.
 * Both are Node.js targets with shared externals for native modules.
 */
export default defineConfig({
  // Pass API_URL from shell environment to the bundled code
  define: {
    'process.env.API_URL': JSON.stringify(process.env.API_URL || ''),
  },
  build: {
    rollupOptions: {
      external: [
        // Node.js built-ins that Vite doesn't recognize
        'node:sqlite',
        // Native modules - must be loaded at runtime, not bundled
        'node-pty',
        '@vscode/ripgrep',
        // fsevents is native on macOS - chokidar uses it but has pure JS fallback
        'fsevents',
        // ws optional native dependencies (not needed, ws works without them)
        'bufferutil',
        'utf-8-validate',
        // Optional dependencies
        'playwright',
        'playwright-core',
        'chromium-bidi',
        /^chromium-bidi\/.*/,
        '@ngrok/ngrok',
        /^@ngrok\/.*/,
      ],
    },
  },
});
