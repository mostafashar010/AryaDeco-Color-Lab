import { test, expect } from '@playwright/test';
import fixture from '../src/fixtures/neutral-cards-real.json' with { type: 'json' };

for (const realCards of [false, true]) test(`automatic live mode ${realCards ? 'detects supplied cards then' : 'without cards'} matches without drawing or shutter`, async ({ page, context }) => {
  const apiFailures: string[] = [];
  page.on('response', async response => { if (response.url().includes('/api/') && response.status()>=400) apiFailures.push(`${response.status()} ${await response.text()}`); });
  await page.addInitScript(({ realCards, fixture }) => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext('2d')!;
    let sequence = 0;
    let drive = [0.5, 0.5, 0.5];
    let showCards = realCards;
    const cards = document.createElement('canvas'); cards.width = fixture.width; cards.height = fixture.height;
    const bytes = Uint8ClampedArray.from(atob(fixture.rgbaBase64),c=>c.charCodeAt(0));
    cards.getContext('2d')!.putImageData(new ImageData(bytes,fixture.width,fixture.height),0,0);
    Object.assign(window,{setLiveCardScene:(value:boolean)=>{showCards=value;draw();}});
    const draw = () => {
      ctx.fillStyle = 'rgb(83,72,61)'; ctx.fillRect(0,0,640,480);
      if (showCards) { ctx.drawImage(cards,0,0,480,480); return; }
      ctx.fillStyle = 'rgb(119,119,119)'; ctx.fillRect(315,105,270,180);
      ctx.fillStyle = `rgb(${drive.map(v => Math.round(v*255)).join(',')})`; ctx.fillRect(320,110,260,170);
      const bits = [0,1,0,1,...Array.from({length:24},(_,i) => (sequence >>> (23-i))&1)];
      bits.forEach((bit,i) => { ctx.fillStyle = bit ? '#fafafa' : '#050505'; ctx.fillRect(310+i*10,300,10,20); });
      [[102,82,72],[112,92,82]].forEach((rgb,i) => { ctx.fillStyle = `rgb(${rgb.join(',')})`; ctx.fillRect(45,80+i*90,170,90); });
    };
    draw(); setInterval(draw,35);
    const NativeSocket = window.WebSocket;
    class SimulatedSocket extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url,protocols);
        this.addEventListener('message',message => {
          const event = JSON.parse(message.data);
          if (event.event === 'display.patch.set') { sequence = event.payload.commandSequence; drive = event.payload.displayDriveRgb; draw(); }
        });
      }
    }
    Object.assign(window,{WebSocket:SimulatedSocket});
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async () => canvas.captureStream(28)});
  }, { realCards, fixture });
  await page.goto('/');
  await page.getByRole('button',{name:'تطبیق زندهٔ ساده، بدون کارت',exact:true}).click();
  const display = await context.newPage();
  const link = page.getByRole('link',{name:'بازکردن نمایشگر A',exact:true});
  await expect(link).toBeVisible();
  await display.goto((await link.getAttribute('href'))!);
  await expect(display.getByRole('heading',{name:'نمایشگر A'})).toBeVisible();
  await page.getByRole('button',{name:'بازکردن دوربین و دیدن کادر',exact:true}).click();
  await expect(page.locator('video')).toBeVisible();
  await expect.poll(()=>page.locator('video').evaluate((video:HTMLVideoElement)=>video.videoWidth)).toBeGreaterThan(0);
  await page.getByLabel('چیدمان، شاهد و شرایط ثابت را برای شروع خودکار بررسی کردم').check();
  // Simulator has no reference card. The explicit no-card choice is not a calibration claim.
  if (!realCards) {
    const skip = page.getByRole('button',{name:'ادامه بدون کارت، آزمایشی',exact:true});
    await expect(skip).toBeVisible({timeout:30_000});
    await skip.click();
  } else {
    const examine=page.getByRole('button',{name:'تطبیق دقیق آزمایشی',exact:true});
    await expect(examine).toBeEnabled({timeout:15_000});
    const report=page.waitForResponse(response=>response.url().endsWith('/neutral-check')&&response.request().method()==='POST',{timeout:15000});
    await examine.click();
    const neutral=await report;expect(neutral.status(),await neutral.text()).toBe(200);
    expect(apiFailures).toEqual([]);
    await expect(page.getByRole('status',{name:'اقدام بعدی'})).toContainText('پارچه و نمایشگر را کنار هم', {timeout:15_000});
  }
  await page.evaluate(()=> (window as unknown as {setLiveCardScene:(value:boolean)=>void}).setLiveCardScene(false));
  const inspect=page.getByRole('button',{name:'تطبیق دقیق آزمایشی',exact:true});
  await expect(inspect).toBeEnabled({timeout:15_000});await inspect.click();
  await expect(page.getByRole('region',{name:'صف نمونه‌های خودکار'})).toBeVisible({timeout:30_000});
  await expect(page.getByRole('region',{name:'صف نمونه‌های خودکار'})).toContainText('تطبیق', {timeout:30_000});
  await expect(page.getByRole('button',{name:'توقف اجرای خودکار',exact:true})).toBeDisabled({timeout:45_000});
  const errors = page.getByRole('alert');
  await expect(errors).toHaveCount(0);
  expect(await page.getByRole('region',{name:'صف نمونه‌های خودکار'}).locator('li').count()).toBeGreaterThanOrEqual(2);
  await display.close();
});
