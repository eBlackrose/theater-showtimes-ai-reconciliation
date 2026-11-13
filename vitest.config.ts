import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "~": path.resolve(import.meta.dirname, "src"),
      // server-only throws outside the Next.js bundler; tests run the server modules directly.
      "server-only": path.resolve(import.meta.dirname, "tests/server-only-stub.ts"),
    },
  },
  test: { include: ["tests/unit/**/*.test.ts", "tests/agent/**/*.test.ts"] },
});
