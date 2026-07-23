import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/shared/**/*.test.ts", "src/main/**/*.test.ts"],
    benchmark: {
      include: ["src/shared/**/*.bench.ts"],
    },
    environment: "node",
  },
});
