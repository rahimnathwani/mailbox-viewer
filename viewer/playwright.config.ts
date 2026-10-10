import { defineConfig, devices } from "@playwright/test";

// Builds the fictional demo mailbox (word search only) into its own folder and serves it like `mbv preview`.
const PORT = 8123;
export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  expect: { timeout: 15_000 }, // first load fetches DuckDB-WASM from the CDN
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 900 } },
      testIgnore: /mobile/,
    },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile/ },
  ],
  webServer: {
    command: `cd .. && uv run mbv --dist viewer/.e2e-dist build tests/fixtures/demo --slug demo --title Demo --no-embed && uv run mbv --dist viewer/.e2e-dist preview --port ${PORT}`,
    url: `http://localhost:${PORT}/data/datasets.json`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
