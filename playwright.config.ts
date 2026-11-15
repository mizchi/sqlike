import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", timeout: 45000, workers: 1,
  use: { baseURL: "http://127.0.0.1:14173", headless: true, trace: "retain-on-failure" },
  webServer: [
    { command: "PORT=19878 DATA_DIR=data/e2e pnpm relay", url: "http://127.0.0.1:19878/api/health/snapshot", reuseExistingServer: false },
    { command: "pnpm do:dev", url: "http://127.0.0.1:19879/api/health/snapshot", reuseExistingServer: false, timeout: 60000 },
    { command: "pnpm exec vite preview", url: "http://127.0.0.1:14173", reuseExistingServer: false },
  ],
});
