import { test, expect } from '@playwright/test'

test.skip(!process.env.COLORLAB_LAN_TEST_ORIGIN, 'Optional LAN test requires a separately running HTTPS server')
test.use({ baseURL: process.env.COLORLAB_LAN_TEST_ORIGIN ?? 'https://192.168.8.8:8444', ignoreHTTPSErrors: true })

test('LAN HTTPS publishes setup and public certificate, never a private key', async ({ page, request }) => {
  // Ignored browser trust is ONLY a software test; real phones still install/trust CA.
  const response = await page.goto('/phone-setup')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { name: 'راه‌اندازی یک‌بارهٔ دو گوشی' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'دریافت گواهی عمومی برای نصب روی گوشی' })).toBeVisible()
  const info = await request.get('/api/connection-info')
  expect((await info.json()).https).toBe(true)
  const cert = await request.get('/phone-root-ca.crt')
  expect(cert.status()).toBe(200)
  expect(await cert.text()).toContain('BEGIN CERTIFICATE')
  expect((await request.get('/phone-root-ca.key')).status()).toBe(404)
})
