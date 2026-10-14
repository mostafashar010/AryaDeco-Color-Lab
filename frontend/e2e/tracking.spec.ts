import { test,expect } from '@playwright/test';
import fixture from '../src/fixtures/neutral-cards-real.json' with {type:'json'};

test('preview tracks moved cards continuously without starting a measurement and exports diagnostic trace',async({page})=>{
  const writes:string[]=[];
  page.on('request',request=>{if(request.method()==='POST'&&/neutral-check|camera-matches|measurements/.test(request.url()))writes.push(request.url());});
  await page.addInitScript(({fixture})=>{
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
    const ctx=canvas.getContext('2d')!;
    const photo=document.createElement('canvas');photo.width=fixture.width;photo.height=fixture.height;
    photo.getContext('2d')!.putImageData(new ImageData(Uint8ClampedArray.from(atob(fixture.rgbaBase64),c=>c.charCodeAt(0)),fixture.width,fixture.height),0,0);
    let offset=0;
    const draw=()=>{ctx.fillStyle='#53483d';ctx.fillRect(0,0,640,480);ctx.drawImage(photo,offset,0,480,480);};
    Object.assign(window,{moveDiagnosticCards:()=>{offset=140;draw();}});
    setInterval(draw,35);draw();
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>canvas.captureStream(28)});
  },{fixture});
  await page.goto('/');await page.getByRole('button',{name:'تطبیق زندهٔ ساده، بدون کارت',exact:true}).click();
  const open=page.getByRole('button',{name:'بازکردن دوربین و دیدن کادر',exact:true});
  await open.click();
  const preview=page.getByLabel('پیش‌نمایش زندهٔ دوربین', {exact:true});await expect(preview).toBeVisible();
  await expect(page.getByRole('status',{name:'وضعیت پیش‌نمایش'})).toContainText('هنوز اندازه‌گیری شروع نشده');
  await expect(page.getByRole('status',{name:'پایداری ردیابی'})).toContainText('سه تشخیص پایدار',{timeout:20_000});
  const overlays=page.getByRole('img',{name:'ردیابی ناحیه‌های زنده'}).locator('polygon.roi');
  await expect(overlays).toHaveCount(3);const before=await overlays.first().getAttribute('points');
  await page.evaluate(()=>(window as unknown as {moveDiagnosticCards:()=>void}).moveDiagnosticCards());
  await expect.poll(()=>overlays.first().getAttribute('points'),{timeout:15_000}).not.toBe(before);
  await expect(page.getByRole('status',{name:'پایداری ردیابی'})).toContainText('سه تشخیص پایدار',{timeout:20_000});
  expect(writes).toEqual([]);
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'دریافت ردگیری JSON',exact:true}).click();
  const stream=await(await download).createReadStream();if(!stream)throw new Error('No trace bytes');
  const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));
  const trace=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(trace.events.some((event:{area:string})=>event.area==='tracking')).toBe(true);
  expect(trace.containsImages).toBe(false);expect(trace.events.length).toBeLessThanOrEqual(300);
  expect(JSON.stringify(trace)).not.toMatch(/cameraToken|displayToken|Bearer|rgbaBase64/);
});
