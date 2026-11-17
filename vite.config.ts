import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8080", "/auth": "http://localhost:8080", "/return": "http://localhost:8080", "/bloom": "http://localhost:8080", "/__mock": "http://localhost:8080" } },
});
