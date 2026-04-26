import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Give hooks 30 s — concurrent embedded-postgres inits can take longer than the default 10 s.
    hookTimeout: 30_000,
    // Limit parallelism to avoid concurrent embedded-postgres pnpm install collisions.
    poolOptions: {
      forks: { maxForks: 4 },
    },
  },
});
