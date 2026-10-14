import {describe,it,expect} from 'vitest';
import {responseCardRegions, selectResponseWitness} from './responseTracking';
import type {Region} from './sampling';
import {detectNeutralCards} from './neutralCards';
import {execFileSync} from 'node:child_process';

function witnessScene(two = false) {
  const width=400,height=300,data=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<data.length;i+=4)data.set([210,195,170,255],i);
  const paint=(left:number,top:number,color:number[])=>{for(let y=top;y<top+100;y++)for(let x=left;x<left+65;x++)data.set([...color,255],(y*width+x)*4);};
  paint(40,80,[120,120,130]); if(two)paint(290,80,[125,125,135]);
  const screen:Region={id:'auto-display',label:'A',order:0,mode:'solid',polygon:[[140,50],[250,50],[250,240],[140,240]],exclusions:[],background:null,layers:null,direction:null,operatorConfirmed:false,selectionMethod:'autoDetected'};
  return {image:{width,height,data},screen};
}
describe('experimental response witness geometry serialization',()=>{
  it('selects one bounded moderate witness without requiring a calibrated three-card set',()=>{
    const {image,screen}=witnessScene(); const cards=detectNeutralCards(image);
    expect(cards.cards).toHaveLength(0);
    const chosen=selectResponseWitness(image,cards,screen);
    expect(chosen.status).toBe('selected');
    expect(chosen.card?.region).toMatchObject({label:'کارت شاهد پیشنهادی، مقادیر مرجع نامعلوم',operatorConfirmed:false,selectionMethod:'autoDetected'});
    expect(chosen.card?.role).toBe('middle');
    expect(chosen.card).not.toHaveProperty('nominalLab');
  });
  it('sorts competing moderate candidates by distance without claiming either identity',()=>{
    const {image,screen}=witnessScene(true); const chosen=selectResponseWitness(image,detectNeutralCards(image),screen);
    expect(chosen.status).toBe('ambiguous'); expect(chosen.card).toBeUndefined();
    expect(chosen.eligibleCount).toBe(2);expect(chosen.ordering[0].distance).toBeLessThanOrEqual(chosen.ordering[1].distance);
  });
  it('never uses a whole warm-white exposure background or a candidate inside the known screen as a witness',()=>{
    const {image,screen}=witnessScene();image.data.fill(255);
    expect(selectResponseWitness(image,detectNeutralCards(image),screen).card).toBeUndefined();
    const proposals={status:'needsFraming' as const,cards:[],nextAction:'',evidence:{referenceValues:'unknown' as const,physicalStandardVerified:false as const,method:'boundedColorComponentsOrientedGeometry' as const,candidateCount:1,analysisWidth:400,analysisHeight:300,limitations:[],candidateGeometry:[{polygon:screen.polygon,label:'screen',observedBrightness:.5}]}};
    expect(selectResponseWitness(witnessScene().image,proposals,screen).rejections.screenOverlap).toBe(1);
  });
  it('finds the actual single gray proposal in the native 07-22-01 camera crop but never authorizes an AWAIT screen',()=>{
    const data=new Uint8ClampedArray(execFileSync('../.venv/bin/python',['-c','from PIL import Image; import sys; im=Image.open(sys.argv[1]).convert("RGBA").crop((48,294,543,789)); sys.stdout.buffer.write(im.tobytes())','/home/betoche/Downloads/Telegram Desktop/photo_2026-10-14_07-22-01.jpg'],{maxBuffer:2_000_000}));
    const image={width:495,height:495,data},cards=detectNeutralCards(image);
    const chosen=selectResponseWitness(image,cards,{...witnessScene().screen,polygon:[[58,94],[210,94],[210,410],[58,410]]});
    expect(chosen.status).toBe('selected');
    expect(chosen.card?.region.polygon.every(([x,y])=>x>250&&x<370&&y>170&&y<350)).toBe(true);
    expect(selectResponseWitness(image,cards).status).toBe('needsFraming');
    expect(cards.cards).toHaveLength(0);
  });
  it('preserves current middle-card evidence and removes detector-only fields',()=>{
    const region:Region={id:'auto-neutral-middle',label:'مشاهده‌شده',order:1,mode:'solid',polygon:[[10,20],[50,20],[50,80],[10,80]],exclusions:[],background:null,layers:null,direction:null,operatorConfirmed:false,selectionMethod:'autoDetected'};
    const observed={role:'middle' as const,region,observedRgb:[.5,.4,.3],confidence:.9};
    const cards=responseCardRegions([observed],2,3);
    expect(cards[0].region.polygon).toEqual([[20,60],[100,60],[100,240],[20,240]]);
    expect(cards[0].region.operatorConfirmed).toBe(false);expect(cards[0]).not.toHaveProperty('observedRgb');
    expect(cards[0].role).toBe('middle');
  });
});
