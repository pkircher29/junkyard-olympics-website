import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["tests/acceptance-contract.test.mjs", "node_modules/**", "dist/**"],
  },
});
