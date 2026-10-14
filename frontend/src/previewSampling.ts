import type {PixelImage} from './marker';
import {bounds,contains,type Region} from './sampling';

export type ScreenAppearanceBand = {id:string;rgb:[number,number,number];validPixels:number;validBlocks:number;blockSpread:number;clippedRate:number};
export type ScreenSampleReason='invalidImage'|'invalidBand'|'insufficientPixels'|'insufficientBlocks'|'cameraShadowClipped'|'cameraHighlightClipped'|'spatiallyMixed';
export type ScreenBandEvidence={id:string;top:number;bottom:number;rgb?:[number,number,number];validPixels:number;validBlocks:number;blockSpread:number;clippedRate:number;shadowClippedRate:number;highlightClippedRate:number;reasons:ScreenSampleReason[]};
export function inspectScreenBands(image:PixelImage,screen:Region,bands:{id:string;top:number;bottom:number}[]):ScreenBandEvidence[]{
  const validImage=image.data.length===image.width*image.height*4&&image.width*image.height<=640*640&&screen.polygon.length===4;
  const scale=image.data instanceof Uint8ClampedArray?255:1;
  const median=(values:number[])=>{values.sort((a,b)=>a-b);return values[Math.floor(values.length/2)];};
  const [tl,tr,br,bl]=screen.polygon;
  return bands.slice(0,32).map(band=>{
    const evidence:ScreenBandEvidence={id:band.id,top:band.top,bottom:band.bottom,validPixels:0,validBlocks:0,blockSpread:0,clippedRate:0,shadowClippedRate:0,highlightClippedRate:0,reasons:[]};
    if(!validImage){evidence.reasons.push('invalidImage');return evidence;}
    if(!Number.isFinite(band.top)||!Number.isFinite(band.bottom)||band.top<0||band.bottom>1||band.bottom<=band.top){evidence.reasons.push('invalidBand');return evidence;}
    if(Math.min(Math.hypot(tl[0]-bl[0],tl[1]-bl[1]),Math.hypot(tr[0]-br[0],tr[1]-br[1]))*(band.bottom-band.top)<8){evidence.reasons.push('insufficientPixels');return evidence;}
    const blocks:number[][][]=Array.from({length:16},()=>[]),seen=new Set<number>();let total=0,clipped=0,shadow=0,highlight=0,invalid=0;
    for(let y=0;y<16;y++)for(let x=0;x<16;x++){
      const u=.15+(x+.5)/16*.7,v=band.top+(band.bottom-band.top)*(.15+(y+.5)/16*.7);
      const px=(1-v)*((1-u)*tl[0]+u*tr[0])+v*((1-u)*bl[0]+u*br[0]);
      const py=(1-v)*((1-u)*tl[1]+u*tr[1])+v*((1-u)*bl[1]+u*br[1]);
      if(px<0||py<0||px>=image.width||py>=image.height||!contains([px,py],screen.polygon)||screen.exclusions.some(p=>contains([px,py],p)))continue;
      const offset=(Math.floor(py)*image.width+Math.floor(px))*4;if(seen.has(offset))continue;seen.add(offset);total++;
      const rgb=[0,1,2].map(c=>Number(image.data[offset+c])/scale);
      const dark=rgb.some(v=>v<=1/255),bright=rgb.some(v=>v>=254/255);
      const malformed=Number(image.data[offset+3])/scale<.99||rgb.some(v=>!Number.isFinite(v)||v<0||v>1);if(malformed)invalid++;
      if(dark)shadow++;if(bright)highlight++;
      if(malformed||dark||bright){clipped++;continue;}
      blocks[Math.floor(y/4)*4+Math.floor(x/4)].push(rgb);
    }
    const validPixels=blocks.reduce((sum,block)=>sum+block.length,0),validBlocks=blocks.filter(block=>block.length>=4).length;
    Object.assign(evidence,{validPixels,validBlocks,clippedRate:clipped/Math.max(total,1),shadowClippedRate:shadow/Math.max(total,1),highlightClippedRate:highlight/Math.max(total,1)});
    if(evidence.shadowClippedRate>.02)evidence.reasons.push('cameraShadowClipped');
    if(evidence.highlightClippedRate>.02)evidence.reasons.push('cameraHighlightClipped');
    if(validPixels<16)evidence.reasons.push('insufficientPixels');if(validBlocks<4)evidence.reasons.push('insufficientBlocks');
    if(invalid/Math.max(total,1)>.02)evidence.reasons.push('invalidImage');
    if(!validBlocks)return evidence;
    const centers=blocks.filter(block=>block.length>=4).map(block=>[0,1,2].map(c=>median(block.map(rgb=>rgb[c]))));
    const mixed=blocks.filter(block=>block.length>=4).some((block,index)=>{
      const deviations=block.map(pixel=>Math.hypot(...pixel.map((value,c)=>value-centers[index][c]))).sort((a,b)=>a-b);
      return deviations[Math.floor((deviations.length-1)*.9)]>.08;
    });
    if(mixed)evidence.reasons.push('spatiallyMixed');
    const rgb=[0,1,2].map(c=>median(centers.map(rgb=>rgb[c]))) as [number,number,number];
    const blockSpread=Math.max(...centers.map(center=>Math.hypot(...center.map((v,c)=>v-rgb[c]))));
    evidence.blockSpread=blockSpread;if(blockSpread>.08&&!mixed)evidence.reasons.push('spatiallyMixed');
    if(!evidence.reasons.length)evidence.rgb=rgb;
    return evidence;
  });
}
export function sampleScreenBands(image:PixelImage,screen:Region,bands:{id:string;top:number;bottom:number}[]):ScreenAppearanceBand[]{
  return inspectScreenBands(image,screen,bands).flatMap(band=>band.rgb&&!band.reasons.length?[{id:band.id,rgb:band.rgb,validPixels:band.validPixels,validBlocks:band.validBlocks,blockSpread:band.blockSpread,clippedRate:band.clippedRate}]:[]);
}

export function samplePreviewBands(image:PixelImage,regions:Region[],screen?:Region){
  const warnings=['uncalibratedPreview','cameraControlsUnknown','orderedPreview'];
  const targetRejectionReasons:ScreenSampleReason[]=[];
  const bands:{id:string;previewRgb:[number,number,number];top:number;bottom:number}[]=[];
  if(image.data.length!==image.width*image.height*4||image.width*image.height>640*640)return{bands,mapping:'orderedPreview' as const,warnings,targetRejectionReasons:['invalidImage'] as ScreenSampleReason[]};
  const scale=image.data instanceof Uint8ClampedArray?255:1;
  for(const region of [...regions].sort((a,b)=>a.order-b.order).slice(0,32)){
    const b=bounds(region.polygon);if(b.width<8||b.height<8)continue;
    const channels:number[][]=[[],[],[]];let rejected=0,total=0,shadow=0,highlight=0,invalid=0;
    for(let y=b.y+.5;y<b.y+b.height;y+=Math.max(1,b.height/24))for(let x=b.x+.5;x<b.x+b.width;x+=Math.max(1,b.width/32)){
      if(x<0||y<0||x>=image.width||y>=image.height||!contains([x,y],region.polygon)||region.exclusions.some(p=>contains([x,y],p)))continue;
      total++;const index=(Math.floor(y)*image.width+Math.floor(x))*4;const values=[0,1,2].map(c=>Number(image.data[index+c])/scale);
      const malformed=Number(image.data[index+3])/scale<.99||values.some(v=>!Number.isFinite(v)||v<0||v>1),bright=values.some(v=>v>=254/255);
      if(malformed)invalid++;if(bright)highlight++;
      if(malformed||bright){rejected++;continue;}
      if(values.some(value=>value<=1/255))shadow++;
      values.forEach((value,c)=>channels[c].push(value));
    }
    if(channels[0].length<24||rejected/Math.max(total,1)>.1)continue;
    if(shadow/channels[0].length>.02)targetRejectionReasons.push('cameraShadowClipped');
    if(highlight/Math.max(total,1)>.02)targetRejectionReasons.push('cameraHighlightClipped');
    if(invalid/Math.max(total,1)>.02)targetRejectionReasons.push('invalidImage');
    const rgb=channels.map(values=>{values.sort((a,b)=>a-b);return values[Math.floor(values.length/2)];}) as [number,number,number];
    bands.push({id:region.id,previewRgb:rgb,top:0,bottom:1});
  }
  if(screen){
    const aperture=bounds(screen.polygon);
    const aligned=bands.flatMap(band=>{const region=regions.find(r=>r.id===band.id)!;const b=bounds(region.polygon);const top=Math.max(0,(b.y-aperture.y)/aperture.height),bottom=Math.min(1,(b.y+b.height-aperture.y)/aperture.height);return bottom>top?[{...band,top,bottom}]:[];});
    return{bands:aligned,mapping:'screenAligned' as const,warnings:['uncalibratedPreview','cameraControlsUnknown','screenAlignmentUncertain'],targetRejectionReasons:[...new Set(targetRejectionReasons)]};
  }
  bands.forEach((band,i)=>{band.top=i/bands.length;band.bottom=(i+1)/bands.length;});
  return{bands,mapping:'orderedPreview' as const,warnings,targetRejectionReasons:[...new Set(targetRejectionReasons)]};
}
