import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.COLORLAB_TEST_ORIGIN ?? 'http://localhost:8443',
    browserName: 'chromium',
    launchOptions: { executablePath: process.env.COLORLAB_CHROME ?? '/usr/bin/google-chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'mobile-layout', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
})
