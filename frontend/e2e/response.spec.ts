import{test,expect}from'@playwright/test';

test('measured screen response completes on zero-clock video and persists into compensated preview',async({page,context})=>{
  test.setTimeout(120000);
  const failures:string[]=[];
  page.on('response',async response=>{if(response.url().includes('/response-profile')&&response.status()>=400)failures.push(`${response.status()} ${await response.text()}`);});
  await page.addInitScript(()=>{
    const original=HTMLVideoElement.prototype.requestVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback=function(callback){return original.call(this,(now,metadata)=>callback(now,{...metadata,mediaTime:0}));};
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;const ctx=canvas.getContext('2d')!;
    let sequence=0,drive=[.5,.5,.5];
    const response=(drive:number[])=>{
      const [r,g,b]=drive.map(v=>v*v);
      const linear=[.04+.5*r+.07*g,.05+.08*r+.56*g+.015*b,.035+.04*r+.09*g+.53*b];
      return linear.map(v=>Math.round(255*(v<=.0031308?12.92*v:1.055*v**(1/2.4)-.055)));
    };
    const draw=()=>{
      ctx.fillStyle='rgb(85,70,50)';ctx.fillRect(0,0,640,480);
      ctx.fillStyle='#595959';ctx.fillRect(15,85,184,222);
      ctx.fillStyle=`rgb(${response(drive).join(',')})`;ctx.fillRect(22,92,170,194);
      const bits=[0,1,0,1,...Array.from({length:24},(_,i)=>(sequence >>> (23-i))&1)];
      bits.forEach((bit,i)=>{ctx.fillStyle=bit?'#fff':'#000';ctx.fillRect(22+i*6,296,6,12);});
      [[45,49,53],[128,135,142],[210,215,220]].forEach((rgb,i)=>{ctx.fillStyle=`rgb(${rgb.join(',')})`;ctx.fillRect(300,60+i*100,120,75);});
    };
    const NativeSocket=window.WebSocket;class CameraSocket extends NativeSocket{constructor(url:string|URL,protocols?:string|string[]){super(url,protocols);this.addEventListener('message',message=>{const event=JSON.parse(message.data);if(event.event==='display.patch.set'){sequence=event.payload.commandSequence;drive=event.payload.displayDriveRgb;draw();}});}}
    Object.assign(window,{WebSocket:CameraSocket});draw();setInterval(draw,35);
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>canvas.captureStream(28)});
  });
  await page.goto('/');await page.getByRole('button',{name:'تطبیق زندهٔ ساده، بدون کارت',exact:true}).click();
  const join=page.getByRole('link',{name:'بازکردن نمایشگر A',exact:true});await expect(join).toBeVisible();
  const display=await context.newPage();await display.goto((await join.getAttribute('href'))!);
  await page.getByRole('button',{name:'بازکردن دوربین و دیدن کادر',exact:true}).click();
  await expect(page.locator('video')).toBeVisible();
  await page.getByRole('button',{name:'اندازه‌گیری پاسخ نمایشگر',exact:true}).click();
  await expect.poll(async()=>failures.length>0||(await page.getByLabel('وضعیت پاسخ نمایشگر').textContent())?.includes('مدل آماده'),{timeout:100000}).toBe(true);
  expect(failures).toEqual([]);
  await expect(page.getByLabel('وضعیت پاسخ نمایشگر')).toContainText('مدل آماده');
  const next=page.waitForResponse(response=>response.url().endsWith('/live-preview')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'نمایش زندهٔ کالیته',exact:true}).click();
  const preview=await next;expect(preview.status(),await preview.text()).toBe(200);
  const command=await preview.json();expect(command.compensation.status).toBe('cameraReferencedExperimental');
  expect(command.cameraAppearanceBands).toHaveLength(1);
  expect(command.bands[0].drive).not.toEqual(command.cameraAppearanceBands[0].drive);
  await page.getByRole('button',{name:'توقف نمایش زنده',exact:true}).click();await display.close();
});
