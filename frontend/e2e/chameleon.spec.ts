import {test,expect} from '@playwright/test';

for(const frozenClock of [false,true])test(`phone on the left receives changing live swatch stripes ${frozenClock?'with frozen mediaTime zero':''} and test logs are saved automatically`,async({page,context})=>{
  test.setTimeout(90000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const previewRequests:{mediaTime:number;presentedFrames:number}[]=[];
  const feedbackResponses:{feedbackApplied:boolean;perBand:{id:string;residualBefore:number;residualAfter:null}[]}[]=[];
  page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/live-preview'))previewRequests.push(request.postDataJSON().sourceFrame);});
  page.on('response',async response=>{if(response.ok()&&response.request().method()==='POST'&&response.url().endsWith('/live-preview')){try{const command=await response.json();if(command.compensation?.status==='measuredFeedbackExperimental')feedbackResponses.push(command.compensation);}catch{/* A response can finish after test teardown. */}}});
  if(frozenClock){const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});}
  await page.addInitScript(({frozenClock})=>{
    if(frozenClock){const original=HTMLVideoElement.prototype.requestVideoFrameCallback;HTMLVideoElement.prototype.requestVideoFrameCallback=function(callback){return original.call(this,(now,metadata)=>callback(now,{...metadata,mediaTime:0}));};}
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;const ctx=canvas.getContext('2d')!;
    let sequence=0,bands=[{drive:[.5,.5,.5],top:0,bottom:1}],changed=false;
    const draw=()=>{
      for(let y=0;y<480;y++){const band=Math.floor(y/60),shade=Math.round(8*Math.sin(y/16));ctx.fillStyle=`rgb(${95+band*12+shade+(changed?12:0)},${65+band*10+shade},${55+band*9+shade})`;ctx.fillRect(0,y,640,1);}
      ctx.fillStyle='#555';ctx.fillRect(18,68,180,270);ctx.fillStyle='#000';ctx.fillRect(23,73,170,224);
      for(const band of bands){ctx.fillStyle=`rgb(${band.drive.map(v=>Math.round(v*255)).join(',')})`;ctx.fillRect(25,75+band.top*220,166,(band.bottom-band.top)*220);}
      const cells=[0,1,0,1,...Array.from({length:24},(_,i)=>(sequence >>> (23-i))&1)];cells.forEach((bit,i)=>{ctx.fillStyle=bit?'#fff':'#000';ctx.fillRect(24+i*6,306,6,12);});
      ctx.fillStyle='#292d34';ctx.fillRect(255,95,85,120);ctx.fillStyle='#808996';ctx.fillRect(455,86,90,118);
      ctx.fillStyle='#d1d8e1';ctx.fillRect(340,335,105,70);
    };
    Object.assign(window,{changeSwatchAppearance:()=>{changed=true;draw();}});draw();setInterval(draw,35);
    const NativeSocket=window.WebSocket;class CameraSocket extends NativeSocket{constructor(url:string|URL,protocols?:string|string[]){super(url,protocols);this.addEventListener('message',message=>{const event=JSON.parse(message.data);if(event.event==='display.patch.set'){sequence=event.payload.commandSequence;bands=event.payload.bands??[{drive:event.payload.displayDriveRgb,top:0,bottom:1}];draw();}});}}
    Object.assign(window,{WebSocket:CameraSocket});Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>canvas.captureStream(28)});
  },{frozenClock});
  await page.goto('/');await page.getByRole('button',{name:'تطبیق زندهٔ ساده، بدون کارت',exact:true}).click();
  const join=page.getByRole('link',{name:'بازکردن نمایشگر A',exact:true});await expect(join).toBeVisible();
  const display=await context.newPage();await display.goto((await join.getAttribute('href'))!);
  await page.getByRole('button',{name:'بازکردن دوربین و دیدن کادر',exact:true}).click();await expect(page.locator('video')).toBeVisible();
  const started=page.waitForResponse(response=>response.url().endsWith('/live-preview')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'نمایش زندهٔ کالیته',exact:true}).click();const initial=await started;expect(initial.status(),await initial.text()).toBe(200);
  const stripe=display.locator('.live-band');
  await expect.poll(()=>stripe.count(),{timeout:25000}).toBeGreaterThanOrEqual(3);
  await expect.poll(()=>feedbackResponses.filter(r=>r.feedbackApplied&&r.perBand.length>=3).length,{timeout:25000}).toBeGreaterThanOrEqual(2);
  expect(feedbackResponses.flatMap(r=>r.perBand).every(b=>Number.isFinite(b.residualBefore)&&b.residualAfter===null)).toBe(true);
  const firstColor=await stripe.first().evaluate(el=>getComputedStyle(el).backgroundColor);
  await page.evaluate(()=>(window as unknown as {changeSwatchAppearance:()=>void}).changeSwatchAppearance());
  await expect.poll(()=>stripe.first().evaluate(el=>getComputedStyle(el).backgroundColor),{timeout:20000}).not.toBe(firstColor);
  await expect(page.getByText(/ثبت خودکار روی لپ‌تاپ: ذخیره شد/)).toBeVisible({timeout:15000});
  if(frozenClock){
    await expect.poll(()=>previewRequests.length,{timeout:20000}).toBeGreaterThanOrEqual(7);
    expect(previewRequests.every(frame=>frame.mediaTime===0)).toBe(true);
    expect(new Set(previewRequests.map(frame=>frame.presentedFrames)).size).toBe(previewRequests.length);
    await expect(page.getByLabel('ضربان پردازش',{exact:true})).toContainText('ساعت مرورگر ثابت');
  }
  expect(errors).toEqual([]);
  await page.getByRole('button',{name:'توقف نمایش زنده',exact:true}).click();await display.close();
});
