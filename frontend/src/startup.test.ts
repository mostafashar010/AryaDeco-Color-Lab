import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanConditions, loadStartup, startupKey, storeStartup } from './startup';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());
describe('bounded conditions-only startup storage', () => {
  it.each(['broken JSON', 'null', '[]', '{"version":0,"conditions":{"illumination":"old"}}', '{"version":2,"conditions":{"illumination":"future"}}', '{"version":1,"conditions":[]}', 'x'.repeat(4097)])('ignores corrupted or unsupported storage: %s', raw => {
    localStorage.setItem(startupKey, raw);
    expect(loadStartup()).toMatchObject({ restored: false, conditions: cleanConditions(null) });
  });
  it('allows only bounded known string keys and nulls, never tokens, profiles, calibration, mode or session fields', () => {
    const poisoned = { illumination: '  ', cameraModel: '  B  ', displayModel: 'x'.repeat(300), layers: 3, distance: { token: 'secret' }, referenceCard: ['card'], unexpected: 'no', token: 'secret', profiles: { a: 1 }, calibration: 'old', mode: 'replay', sessionId: 'old' };
    localStorage.setItem(startupKey, JSON.stringify({ version: 1, conditions: poisoned, token: 'outer-secret' }));
    const loaded = loadStartup();
    expect(loaded.conditions).toEqual({ illumination: null, cameraModel: 'B', displayModel: 'x'.repeat(256), displayBrightness: null, background: null, layers: null, distance: null, referenceCard: null });
    storeStartup(poisoned as unknown as ReturnType<typeof cleanConditions>);
    expect(JSON.parse(localStorage.getItem(startupKey)!)).toEqual({ version: 1, conditions: loaded.conditions });
  });
  it('handles storage security, quota and removal errors without throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    expect(loadStartup()).toMatchObject({ restored: false, conditions: cleanConditions(null) });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(storeStartup(cleanConditions({ illumination: 'new' }))).toMatch(/ممکن نشد/);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    expect(storeStartup(null)).toMatch(/ممکن نشد/);
  });
});
