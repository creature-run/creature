import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { creature } from "open-mcp-app/vite";

export default defineConfig({
  plugins: [
    react(),
    creature({
      // Generate bundle.js for serverless deployments (Vercel, Lambda)
      // This creates dist/ui/bundle.js with HTML exports
      generateBundle: true,
    }),
    viteSingleFile(),
  ],
});
