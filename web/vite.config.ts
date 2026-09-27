import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { demoApiPlugin } from "./demo/plugin";

export default defineConfig(({ command, mode }) => ({
  plugins: [react(), ...(command === "serve" && mode === "demo" ? [demoApiPlugin()] : [])],
  publicDir: "../packages/ui/public",
  resolve: { dedupe: ["react", "react-dom"], alias: { react: fileURLToPath(new URL("./node_modules/react", import.meta.url)), "react-dom": fileURLToPath(new URL("./node_modules/react-dom", import.meta.url)), recharts: fileURLToPath(new URL("./node_modules/recharts", import.meta.url)) } },
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
  },
}));
