import {bounds,contains,type Point,type Region}from'./sampling';
import type {PixelImage} from './marker';
import type {NeutralCards} from './neutralCards';

export type ResponseWitness = {status:'selected'|'needsFraming'|'ambiguous';card?:{role:'middle';region:Region};candidateCount:number;eligibleCount:number;ordering:{index:number;distance:number}[];rejections:Record<string,number>};
export function selectResponseWitness(image:PixelImage,cards:NeutralCards,screen?:Region):ResponseWitness {
  const proposals=cards.evidence.candidateGeometry??[];
  const result:ResponseWitness={status:'needsFraming',candidateCount:cards.evidence.candidateCount,eligibleCount:0,ordering:[],rejections:{}};
  const reject=(reason:string)=>{result.rejections[reason]=(result.rejections[reason]??0)+1;};
  if(!screen){reject('screenNotObserved');return result;}
  const s=bounds(screen.polygon),scale=image.data instanceof Uint8ClampedArray?255:1;
  const eligible: {index:number;distance:number;polygon:Point[]}[]=[];
  proposals.forEach((candidate,index)=>{
    const polygon=candidate.polygon,b=bounds(polygon);
    if(!Number.isFinite(candidate.observedBrightness)||candidate.observedBrightness<.28||candidate.observedBrightness>.70){reject('brightnessNotModerate');return;}
    const center:Point=[b.x+b.width/2,b.y+b.height/2];
    const shape=polygon.map(([x,y])=>[center[0]+(x-center[0])/.7,center[1]+(y-center[1])/.7] as Point),full=bounds(shape);
    if(full.x<=0||full.y<=0||full.x+full.width>=image.width||full.y+full.height>=image.height){reject('shapeTouchesEdge');return;}
    if(full.x<s.x+s.width&&full.x+full.width>s.x&&full.y<s.y+s.height&&full.y+full.height>s.y){reject('screenOverlap');return;}
    const sum=[0,0,0],squares=[0,0,0];let count=0;
    for(let y=0;y<8;y++)for(let x=0;x<8;x++){
      const px=Math.floor(b.x+(x+.5)*b.width/8),py=Math.floor(b.y+(y+.5)*b.height/8);
      if(!contains([px+.5,py+.5],polygon))continue;
      const offset=(py*image.width+px)*4;
      if(Number(image.data[offset+3])/scale<.99){reject('invalidInterior');return;}
      for(let c=0;c<3;c++){const value=Number(image.data[offset+c])/scale;sum[c]+=value;squares[c]+=value*value;}count++;
    }
    const mean=sum.map(v=>v/count);
    if(count<16||mean.some(v=>!Number.isFinite(v))||Math.max(...mean)-Math.min(...mean)>.15||squares.some((v,c)=>Math.sqrt(Math.max(0,v/count-mean[c]**2))>.055)){reject('coloredOrNonuniformInterior');return;}
    eligible.push({index,distance:Math.hypot(center[0]-s.x-s.width/2,center[1]-s.y-s.height/2),polygon});
  });
  eligible.sort((a,b)=>a.distance-b.distance||a.index-b.index);
  result.ordering=eligible.map(({index,distance})=>({index,distance}));result.eligibleCount=eligible.length;
  if(eligible.length>1){result.status='ambiguous';return result;}
  if(!eligible.length)return result;
  result.status='selected';
  result.card={role:'middle',region:{id:'auto-response-witness',label:'کارت شاهد پیشنهادی، مقادیر مرجع نامعلوم',order:1,mode:'solid',polygon:eligible[0].polygon,exclusions:[],background:null,layers:null,direction:null,operatorConfirmed:false,selectionMethod:'autoDetected'}};
  return result;
}
export function responseCardRegions(cards:{role:'dark'|'middle'|'light';region:Region}[],sx:number,sy:number){
  const map=(points:Point[]):Point[]=>points.map(([x,y])=>[x*sx,y*sy]);
  return cards.map(({role,region:r})=>({role,region:{id:r.id,label:r.label,order:r.order,mode:r.mode,polygon:map(r.polygon),exclusions:r.exclusions.map(map),background:r.background,layers:r.layers,direction:r.direction,operatorConfirmed:false,selectionMethod:'autoDetected' as const}}));
}
