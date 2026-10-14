import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { EvidenceSnapshot } from '../src/trace';

// Correlation artifacts never retain session credentials, URLs, or network traces.
test.use({ trace: 'off', screenshot: 'off' });

test('three simultaneous fixed swatches reduce measured camera RGB error under synthetic display distortion', async ({ page, context }, testInfo) => {
  test.setTimeout(100000);
  type Band = { id: string; drive: number[]; top: number; bottom: number };
  type Observation = { id: string; method: string; residualBefore: number; residualAfter: null; physicalAccuracyVerified: false };
  type Frame = { presentedFrames: number; mediaTime: number; width: number; height: number };
  type Sample = { rgb: number[]; validPixels: number; validBlocks: number; blockSpread: number; clippedRate: number };
  const accepted: { sequence: number; observedSequence: number; frame: number; sourceFrame: Frame; targets: Band[]; issued: Band[]; observed: Sample[]; markerPixels: number[][]; screenRoi: number[][]; perBand: Observation[] }[] = [];
  const commands = new Map<number, Band[]>(), uploads: EvidenceSnapshot[] = [];
  let latestEvidence: Record<string, Record<string, EvidenceSnapshot>> = {}, phase = 'createSession';
  const errors: string[] = [], rejected: { status: number; code: string }[] = [], renderedSequences: number[] = [];
  const fabric = [[90, 135, 165], [160, 105, 70], [110, 160, 100]];
  page.on('pageerror', () => errors.push(`camera:${phase}:pageError`));
  page.on('websocket', socket => socket.on('framereceived', frame => {
    const event = JSON.parse(String(frame.payload));
    if (event.event === 'display.patch.rendered') renderedSequences.push(event.payload.commandSequence);
    if (event.event === 'display.patch.set' && event.payload.bands) commands.set(event.payload.commandSequence, event.payload.bands.map((band: Band) => ({ id: band.id, drive: band.drive, top: band.top, bottom: band.bottom })));
  }));
  page.on('response', async response => {
    if (response.request().method() !== 'POST' || !response.url().endsWith('/live-preview')) return;
    try {
      const command = await response.json();
      if (!response.ok()) { rejected.push({ status: response.status(), code: typeof command.detail === 'string' && /^preview_[a-z_]+$/.test(command.detail) ? command.detail : 'unclassified' }); return; }
      const request = response.request().postDataJSON();
      if (command.compensation?.feedbackApplied && command.compensation.status === 'measuredFeedbackExperimental') {
        accepted.push({ sequence: command.commandSequence, observedSequence: request.feedback.commandSequence, frame: request.sourceFrame.presentedFrames, sourceFrame: request.sourceFrame, targets: request.bands, issued: command.bands, observed: request.feedback.screenAppearanceBands.map(({ rgb, validPixels, validBlocks, blockSpread, clippedRate }: Sample) => ({ rgb, validPixels, validBlocks, blockSpread, clippedRate })), markerPixels: request.feedback.markerPixels, screenRoi: request.feedback.screenRoi, perBand: command.compensation.perBand });
      }
    } catch { errors.push(`camera:${phase}:responseCapture`); }
  });
  await page.addInitScript(({ fabric }) => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext('2d')!;
    let sequence = 0, bands = [{ drive: [0.5, 0.5, 0.5], top: 0, bottom: 1 }];
    // This is a deterministic camera-domain model, not a calibrated physical display.
    const appearance = (drive: number[]) => {
      const gamma = drive.map(value => Math.pow(value, 1.18));
      return [0.90 * gamma[0] + 0.035 * gamma[1] + 0.015 * gamma[2] + 0.018,
        0.025 * gamma[0] + 0.91 * gamma[1] + 0.025 * gamma[2] + 0.012,
        0.015 * gamma[0] + 0.035 * gamma[1] + 0.90 * gamma[2] + 0.022].map(value => Math.round(Math.min(1, Math.max(0, value)) * 255));
    };
    const draw = () => {
      ctx.fillStyle = 'rgb(83,72,61)'; ctx.fillRect(0, 0, 640, 480);
      // The fabric has complete fixed side borders and never follows A's drive.
      ctx.fillStyle = '#18202b'; ctx.fillRect(246, 71, 378, 228);
      fabric.forEach((rgb, index) => { ctx.fillStyle = `rgb(${rgb.join(',')})`; ctx.fillRect(250, 75 + index * 220 / 3, 370, 220 / 3); });
      ctx.fillStyle = '#555'; ctx.fillRect(18, 68, 180, 270);
      ctx.fillStyle = '#000'; ctx.fillRect(23, 73, 170, 224);
      ctx.fillStyle = `rgb(${appearance([0.5, 0.5, 0.5]).join(',')})`; ctx.fillRect(25, 75, 166, 220);
      for (const band of bands) {
        ctx.fillStyle = `rgb(${appearance(band.drive).join(',')})`;
        ctx.fillRect(25, 75 + band.top * 220, 166, (band.bottom - band.top) * 220);
      }
      const cells = [0, 1, 0, 1, ...Array.from({ length: 24 }, (_, index) => sequence >>> (23 - index) & 1)];
      cells.forEach((bit, index) => { ctx.fillStyle = bit ? '#fff' : '#000'; ctx.fillRect(24 + index * 6, 306, 6, 12); });
    };
    draw(); setInterval(draw, 35);
    const NativeSocket = window.WebSocket;
    class CameraSocket extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', message => {
          const event = JSON.parse(message.data);
          if (event.event === 'display.patch.set') {
            sequence = event.payload.commandSequence;
            bands = event.payload.bands ?? [{ drive: event.payload.displayDriveRgb, top: 0, bottom: 1 }];
            draw();
          }
        });
      }
    }
    Object.assign(window, { WebSocket: CameraSocket });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => canvas.captureStream(28) });
  }, { fabric });
  await page.goto('/');
  const created = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/sessions'));
  await page.getByRole('button', { name: 'تطبیق زندهٔ ساده، بدون کارت', exact: true }).click();
  const { sessionId, cameraToken, displayToken, diagnosticsEnabled } = await (await created).json() as { sessionId: string; cameraToken: string; displayToken: string; diagnosticsEnabled: boolean };
  expect(diagnosticsEnabled).toBe(true);
  const join = page.getByRole('link', { name: 'بازکردن نمایشگر A', exact: true }); await expect(join).toBeVisible();
  const display = await context.newPage(); display.on('pageerror', () => errors.push(`display:${phase}:pageError`));
  for (const browser of [page, display]) browser.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/diagnostics')) {
      for (const event of request.postDataJSON().events) if (event.event === 'evidence' && event.details.evidenceSnapshot) uploads.push(event.details.evidenceSnapshot as EvidenceSnapshot);
    }
  });
  await display.goto((await join.getAttribute('href'))!);
  // Remove the fragment-bearing link from failure context without changing the application flow.
  await join.evaluate(element => element.removeAttribute('href'));
  await display.evaluate(() => {
    const history: { sequence: number; rgb: number[][] }[] = [];
    Object.assign(window, { feedbackPaintHistory: history });
    setInterval(() => {
      const cells = [...document.querySelectorAll('.command-marker span')];
      if (cells.length !== 28) return;
      const bits = cells.map(cell => getComputedStyle(cell).backgroundColor === 'rgb(255, 255, 255)' ? 1 : 0);
      if (bits.slice(0, 4).join('') !== '0101') return;
      const sequence = bits.slice(4).reduce((value, bit) => value * 2 + bit, 0);
      const rgb = [...document.querySelectorAll('.live-band')].map(band => getComputedStyle(band).backgroundColor.match(/\d+/g)!.map(channel => Number(channel) / 255));
      if (rgb.length && !history.some(row => row.sequence === sequence)) history.push({ sequence, rgb });
    }, 40);
  });
  const readEvidence = () => page.evaluate(async ({ sessionId, cameraToken }) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/diagnostics/summary`, { headers: { Authorization: `Bearer ${cameraToken}` }, cache: 'no-store' });
    if (!response.ok) return { status: response.status, latestEvidence: {} };
    const summary = await response.json(); return { status: response.status, latestEvidence: summary.latestEvidence ?? {} };
  }, { sessionId, cameraToken });
  phase = 'feedbackLoop';
  await page.getByRole('button', { name: 'بازکردن دوربین و دیدن کادر', exact: true }).click();
  await expect(page.locator('video')).toBeVisible();
  await page.getByRole('button', { name: 'نمایش زندهٔ کالیته', exact: true }).click();
  try {
    await expect.poll(() => accepted.filter(command => command.perBand.length >= 3).length, { timeout: 60000 }).toBeGreaterThanOrEqual(6);
    const first = accepted[0], last = accepted.at(-1)!;
    expect(first.perBand).toHaveLength(3); expect(last.perBand.map(band => band.id)).toEqual(first.perBand.map(band => band.id));
    expect(new Set(accepted.map(command => command.frame)).size).toBe(accepted.length);
    for (const command of accepted) {
      expect(command.targets).toHaveLength(3);
      expect(command.targets.map(band => band.id)).toEqual(first.targets.map(band => band.id));
      command.targets.forEach((band, index) => band.drive.forEach((channel, axis) => expect(Math.abs(channel - fabric[index][axis] / 255)).toBeLessThan(0.015)));
      expect(renderedSequences).toContain(command.observedSequence);
      expect(command.sequence).toBeGreaterThan(command.observedSequence);
      command.perBand.forEach(band => {
        expect(band.method).toBe('nominalTransferDampedFeedback');
        expect(Number.isFinite(band.residualBefore)).toBe(true);
        expect(band.residualAfter).toBeNull(); expect(band.physicalAccuracyVerified).toBe(false);
      });
    }
    for (const initial of first.perBand) {
      expect(initial.residualBefore).toBeGreaterThan(0.01);
      expect(last.perBand.find(band => band.id === initial.id)!.residualBefore).toBeLessThan(initial.residualBefore);
    }
    await expect(display.locator('.live-band')).toHaveCount(3);
    await expect(page.getByRole('status', { name: 'نوع جبران کالیته', exact: true })).toContainText('بازخورد اندازه‌گیری‌شدهٔ صفحه');
    phase = 'diagnosticCorrelation';
    await expect.poll(async () => {
      const summary = await readEvidence(); latestEvidence = summary.latestEvidence;
      const rendered = latestEvidence.display?.rendered, server = latestEvidence.server?.feedbackAccepted, sampled = latestEvidence.camera?.sampled;
      return summary.status === 200 && Boolean(rendered?.bands?.length === 3 && server?.bands?.length === 3 && sampled?.bands?.length === 3 && commands.has(rendered.commandSequence!) && accepted.some(command => command.sequence === server.commandSequence && command.observedSequence === server.observedCommandSequence && command.frame === server.presentedFrames) && accepted.some(command => command.frame === sampled.presentedFrames && command.observedSequence === sampled.observedCommandSequence));
    }, { timeout: 20000 }).toBe(true);
    const rendered = latestEvidence.display.rendered, server = latestEvidence.server.feedbackAccepted, sampled = latestEvidence.camera.sampled;
    expect(uploads).toContainEqual(rendered); expect(uploads).toContainEqual(sampled);
    expect(renderedSequences).toContain(rendered.commandSequence);
    const renderedCommand = commands.get(rendered.commandSequence!)!; expect(renderedCommand).toHaveLength(3);
    const paintHistory = await display.evaluate(() => (window as unknown as { feedbackPaintHistory: { sequence: number; rgb: number[][] }[] }).feedbackPaintHistory);
    const paint = paintHistory.find(row => row.sequence === rendered.commandSequence); expect(paint).toBeDefined();
    expect(rendered).toMatchObject({ role: 'display', stage: 'rendered', rgbEncoding: 'encoded', colorSpace: 'srgb', renderedProof: 'twoAnimationFrames', status: 'renderRequestOnly', physicalAccuracyVerified: false });
    rendered.bands!.forEach((band, index) => {
      expect(band.bandIndex).toBe(index); expect(band.top).toBe(renderedCommand[index].top); expect(band.bottom).toBe(renderedCommand[index].bottom);
      expect(band.driveRgb).toEqual(renderedCommand[index].drive);
      expect(band.renderedPaintRgb).toEqual(renderedCommand[index].drive.map(channel => Math.round(channel * 255) / 255));
      expect(band.renderedPaintRgb).toEqual(paint!.rgb[index]);
    });
    const serverCommand = accepted.find(command => command.sequence === server.commandSequence && command.observedSequence === server.observedCommandSequence && command.frame === server.presentedFrames);
    expect(serverCommand).toBeDefined();
    expect(server).toMatchObject({ role: 'server', stage: 'feedbackAccepted', markerSequence: serverCommand!.sequence, colorSpace: 'srgb', targetColorSpace: 'srgb', driveColorSpace: 'srgb', observedColorSpace: 'srgb', rgbEncoding: 'encoded', residualMetric: 'linearCameraRgb', physicalAccuracyVerified: false, rawMediaTime: serverCommand!.sourceFrame.mediaTime, nativeWidth: serverCommand!.sourceFrame.width, nativeHeight: serverCommand!.sourceFrame.height });
    expect(server.screenRoi).toEqual(serverCommand!.screenRoi);
    const linear = (value: number) => value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    server.bands!.forEach((band, index) => {
      expect(band.bandIndex).toBe(index); expect(band.top).toBe(serverCommand!.targets[index].top); expect(band.bottom).toBe(serverCommand!.targets[index].bottom);
      expect(band.targetRgb).toEqual(serverCommand!.targets[index].drive);
      expect(band.driveRgb).toEqual(serverCommand!.issued[index].drive);
      expect(band.observedRgb).toEqual(serverCommand!.observed[index].rgb);
      const { rgb: _rgb, ...quality } = serverCommand!.observed[index];
      expect(band.quality).toMatchObject({ status: 'accepted', ...quality });
      expect(band.residualBefore).toBeCloseTo(Math.hypot(...band.targetRgb!.map((channel, axis) => linear(channel) - linear(band.observedRgb![axis]))), 10);
    });
    const cameraFrame = accepted.find(command => command.frame === sampled.presentedFrames && command.observedSequence === sampled.observedCommandSequence);
    expect(cameraFrame).toBeDefined();
    expect(sampled).toMatchObject({ role: 'camera', stage: 'sampled', colorSpace: 'srgb', rgbEncoding: 'encoded', markerSequence: cameraFrame!.observedSequence, rawMediaTime: cameraFrame!.sourceFrame.mediaTime, nativeWidth: 640, nativeHeight: 480, physicalAccuracyVerified: false });
    expect(sampled.markerCells).toEqual(cameraFrame!.markerPixels);
    expect(sampled.screenRoi).toEqual(cameraFrame!.screenRoi);
    sampled.bands!.forEach((band, index) => {
      expect(band.bandIndex).toBe(index); expect(band.top).toBe(cameraFrame!.targets[index].top); expect(band.bottom).toBe(cameraFrame!.targets[index].bottom);
      expect(band.targetRgb).toEqual(cameraFrame!.targets[index].drive);
      expect(band.observedRgb).toEqual(cameraFrame!.observed[index].rgb);
      expect(band.driveRgb).toEqual(commands.get(cameraFrame!.observedSequence)![index].drive);
      const { rgb: _rgb, ...quality } = cameraFrame!.observed[index];
      expect(band.quality).toMatchObject({ status: 'accepted', ...quality });
    });
    for (const failed of uploads.filter(snapshot => snapshot.role === 'camera' && snapshot.stage === 'rejected' && snapshot.rejectionReasons?.includes('markerMissing'))) {
      expect(failed.markerSequence).toBeUndefined(); expect(failed.markerCells).toBeUndefined(); expect(failed.observedCommandSequence).toBeUndefined();
    }
    expect(errors).toEqual([]);
  } finally {
    const evidence = testInfo.outputPath('synthetic-camera-feedback-evidence.json');
    const safeArtifact = JSON.stringify({ domain: 'synthetic encoded camera RGB, not physical accuracy', phase, fabric, accepted, latestEvidence, rejected, renderedSequences, errors }, null, 2);
    expect(safeArtifact.includes(cameraToken) || safeArtifact.includes(displayToken) || safeArtifact.includes(sessionId)).toBe(false);
    await writeFile(evidence, safeArtifact);
    await testInfo.attach('synthetic-camera-feedback-evidence', { path: evidence, contentType: 'application/json' });
    const stop = page.getByRole('button', { name: 'توقف نمایش زنده', exact: true });
    if (await stop.isEnabled()) await stop.click();
    await display.close();
  }
});
