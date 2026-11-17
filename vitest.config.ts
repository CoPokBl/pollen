import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"], env: { DATA_DIR: "/tmp/pollen-test-data" } } });
