import { defineConfig } from 'vite';
import { resolve } from 'path';

/**
 * Vite config for the popout bridge script.
 * 
 * Builds popout-mcp-bridge.ts as an IIFE for use in popout HTML files.
 * The HTML files are static and just copied alongside the built JS.
 */
export default defineConfig({
  build: {
    outDir: 'dist/assets/popouts',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/assets/popouts/popout-mcp-bridge.ts'),
      formats: ['iife'],
      name: 'PopoutBridge',
      fileName: () => 'popout-mcp-bridge.js',
    },
  },
});
