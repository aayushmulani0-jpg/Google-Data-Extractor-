import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./", // Relative paths — required for Chrome extension popup
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        background: "src/background.js",
        content: "src/content.js",
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name].[ext]",
      },
    },
  },
});
