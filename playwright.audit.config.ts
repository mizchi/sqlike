import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.audit.ts",
  timeout: 120000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:14173",
    headless: true,
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec vite preview",
    url: "http://127.0.0.1:14173",
    reuseExistingServer: false,
  },
});
