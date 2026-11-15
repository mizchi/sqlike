import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "lite.spec.ts",
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:14173",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec vite preview",
    url: "http://127.0.0.1:14173/lite/",
    reuseExistingServer: false,
  },
});
