import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { demoApiPlugin } from "./demo/plugin";

export default defineConfig(({ command, mode }) => ({
  plugins: [react(), ...(command === "serve" && mode === "demo" ? [demoApiPlugin()] : [])],
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
  },
}));
