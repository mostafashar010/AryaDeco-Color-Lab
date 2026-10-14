import{test,expect}from'@playwright/test';
test('live image diagnosis is opt-in, captures the actual video and stops uploading',async({page})=>{
  const uploads:string[]=[];page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/live-debug/frames'))uploads.push(request.url());});
  await page.addInitScript(()=>{
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;const ctx=canvas.getContext('2d')!;
    ctx.fillStyle='#ddd5c7';ctx.fillRect(0,0,640,480);ctx.fillStyle='#808896';ctx.fillRect(300,160,150,100);
    setInterval(()=>{ctx.fillStyle='#3d3d3d';ctx.fillRect(30,30,100,30);},40);
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>canvas.captureStream(24)});
  });
  await page.goto('/');await page.getByRole('button',{name:'تطبیق زندهٔ ساده، بدون کارت',exact:true}).click();
  await page.getByRole('button',{name:'بازکردن دوربین و دیدن کادر',exact:true}).click();
  const panel=page.getByRole('region',{name:'عیب‌یابی زنده با تصویر',exact:true});await expect(panel).toBeVisible();
  expect(uploads).toHaveLength(0);await expect(panel.getByRole('button',{name:'شروع عیب‌یابی تصویری زنده'})).toBeDisabled();
  await panel.getByRole('checkbox').check();const upload=page.waitForResponse(response=>response.url().endsWith('/live-debug/frames')&&response.request().method()==='POST');
  await panel.getByRole('button',{name:'شروع عیب‌یابی تصویری زنده'}).click();
  const response=await upload;expect(response.status(),await response.text()).toBe(200);
  await expect(panel.getByRole('status')).toContainText('ذخیره شد');expect(uploads).toHaveLength(1);
  const stopped=page.waitForResponse(response=>response.url().endsWith('/live-debug')&&response.request().method()==='POST');
  await panel.getByRole('button',{name:'توقف و پاک‌کردن تصاویر عیب‌یابی'}).click();expect((await stopped).status()).toBe(200);
  await expect(panel.getByRole('status')).toContainText('پاک شدند');
  await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,4500)));expect(uploads).toHaveLength(1);
});
