import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["tests/sho-3136-branding.test.tsx"] },
});
