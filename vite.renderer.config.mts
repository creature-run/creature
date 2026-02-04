import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    watch: {
      ignored: ['**/artifacts/**']
    }
  },
  resolve: {
    // Force all React imports to use the same instance.
    // Prevents "Invalid hook call" errors when dependencies have their own React.
    dedupe: ["react", "react-dom"],
    alias: {
      // Ensure React resolves to local node_modules
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
    },
  },
});
