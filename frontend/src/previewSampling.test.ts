import {describe,it,expect} from 'vitest';
import {samplePreviewBands,sampleScreenBands,inspectScreenBands} from './previewSampling';
import type {Region} from './sampling';
const regions:Region[]=[0,1].map(i=>({id:`band-${i}`,label:'fabric',order:i,mode:'bands',polygon:[[0,i*40],[80,i*40],[80,(i+1)*40],[0,(i+1)*40]],exclusions:[],background:null,layers:null,direction:null,operatorConfirmed:false,selectionMethod:'autoDetected'}));
function image(){const data=new Uint8ClampedArray(80*80*4);for(let y=0;y<80;y++)for(let x=0;x<80;x++)data.set(y<40?[100,80,60,255]:[130,110,90,255],(y*80+x)*4);return{width:80,height:80,data};}
describe('camera appearance preview, not calibrated fabric colors',()=>{
  it('keeps opaque black fabric in raw preview without authorizing clipped screen feedback',()=>{
    const target=image();for(let offset=0;offset<target.data.length;offset+=4)target.data.set([0,0,0,255],offset);
    const preview=samplePreviewBands(target,regions);
    expect(preview.bands).toHaveLength(2);expect(preview.bands[0].previewRgb).toEqual([0,0,0]);
    expect(preview.targetRejectionReasons).toContain('cameraShadowClipped');
    const screen={...regions[0],polygon:[[0,0],[80,0],[80,80],[0,80]] as [number,number][]};
    const result=inspectScreenBands(target,screen,[{id:'black',top:0,bottom:1}]);
    expect(result[0].reasons).toContain('cameraShadowClipped');expect(result[0].shadowClippedRate).toBe(1);
    expect(sampleScreenBands(target,screen,[{id:'black',top:0,bottom:1}])).toEqual([]);
  });
  it('samples each region and preserves order without full pixel export',()=>{
    const preview=samplePreviewBands(image(),regions);expect(preview.bands).toHaveLength(2);
    expect(preview.bands[0].previewRgb[0]).toBeCloseTo(100/255);expect(preview.bands[1].previewRgb[0]).toBeCloseTo(130/255);
    expect(preview.mapping).toBe('orderedPreview');expect(preview.warnings).toContain('uncalibratedPreview');
    expect(preview.bands[0].top).toBe(0);expect(preview.bands[1].bottom).toBe(1);
  });
  it('does not produce preview colors for clipped transparent or unknown sources',()=>{
    const clipped=image();clipped.data.fill(255);expect(samplePreviewBands(clipped,regions).bands).toHaveLength(0);
    const transparent=image();for(let i=3;i<transparent.data.length;i+=4)transparent.data[i]=0;
    expect(samplePreviewBands(transparent,regions).bands).toHaveLength(0);
  });
  it('keeps exclusion shapes out of statistics and omits tiny regions',()=>{
    const target=image();for(let y=0;y<40;y++)for(let x=0;x<20;x++)target.data.set([255,0,0,255],(y*80+x)*4);
    const excluded={...regions[0],exclusions:[[[0,0],[20,0],[20,40],[0,40]] as [number,number][]]};
    expect(samplePreviewBands(target,[excluded]).bands[0].previewRgb[0]).toBeCloseTo(100/255);
    expect(samplePreviewBands(target,[{...excluded,polygon:[[0,0],[2,0],[2,2],[0,2]]}]).bands).toHaveLength(0);
  });
  it('projects only the visible vertical part onto an actually detected screen aperture',()=>{
    const screen={...regions[0],id:'screen',polygon:[[0,20],[80,20],[80,60],[0,60]] as [number,number][]};
    const result=samplePreviewBands(image(),regions,screen);
    expect(result.mapping).toBe('screenAligned');expect(result.bands[0].top).toBe(0);expect(result.bands[0].bottom).toBe(.5);
    expect(result.bands[1].top).toBe(.5);expect(result.bands[1].bottom).toBe(1);expect(result.warnings).toContain('screenAlignmentUncertain');
  });
  it('measures every displayed band statistically in its own interior, not the fabric or a single pixel',()=>{
    const target=image(),screen={...regions[0],id:'screen',polygon:[[0,0],[80,0],[80,80],[0,80]] as [number,number][]};
    target.data.set([240,220,200,255],(20*80+40)*4);
    const measured=sampleScreenBands(target,screen,[{id:'first',top:0,bottom:.5},{id:'second',top:.5,bottom:1}]);
    expect(measured).toHaveLength(2);
    expect(measured[0].rgb[0]).toBeCloseTo(100/255);
    expect(measured[1].rgb[0]).toBeCloseTo(130/255);
    expect(measured.every(b=>b.validPixels>=16&&b.validBlocks>=4&&b.blockSpread<=.08&&b.clippedRate<=.02)).toBe(true);
    expect(measured.map(b=>b.id)).toEqual(['first','second']);
  });
  it('rejects tiny repeated-pixel bands and clipped or spatially mixed display interiors',()=>{
    const screen={...regions[0],id:'screen',polygon:[[0,0],[80,0],[80,80],[0,80]] as [number,number][]};
    expect(sampleScreenBands(image(),screen,[{id:'tiny',top:0,bottom:.005}])).toHaveLength(0);
    const mixed=image();for(let y=0;y<80;y++)for(let x=40;x<80;x++)mixed.data.set([200,180,160,255],(y*80+x)*4);
    expect(sampleScreenBands(mixed,screen,[{id:'mixed',top:0,bottom:.5}])).toHaveLength(0);
    const clipped=image();clipped.data.fill(255);
    expect(sampleScreenBands(clipped,screen,[{id:'white',top:0,bottom:1}])).toHaveLength(0);
  });
  it('rejects finely interleaved mixtures even when all block medians agree',()=>{
    const target=image(),screen={...regions[0],polygon:[[0,0],[80,0],[80,80],[0,80]] as [number,number][]};
    for(let y=0;y<80;y++)for(let x=0;x<80;x++)target.data.set((x+y)%2?[60,80,100,255]:[180,200,220,255],(y*80+x)*4);
    expect(sampleScreenBands(target,screen,[{id:'checker',top:0,bottom:1}])).toHaveLength(0);
  });
  it('separates highlight and shadow rejection and retains tiny-band evidence without invented RGB',()=>{
    const screen={...regions[0],polygon:[[0,0],[80,0],[80,80],[0,80]] as [number,number][]};
    const white=image();white.data.fill(255);
    const [bright]=inspectScreenBands(white,screen,[{id:'white',top:0,bottom:1}]);
    expect(bright.reasons).toContain('cameraHighlightClipped');expect(bright.shadowClippedRate).toBe(0);expect(bright.rgb).toBeUndefined();
    const [tiny]=inspectScreenBands(image(),screen,[{id:'tiny',top:0,bottom:.005}]);
    expect(tiny.reasons).toContain('insufficientPixels');expect(tiny.rgb).toBeUndefined();
  });
  it('does not let one dark pixel conceal a transparent contaminated screen interior',()=>{
    const target=image(),screen={...regions[0],polygon:[[0,0],[80,0],[80,80],[0,80]] as [number,number][]};
    for(let y=12;y<25;y++)for(let x=12;x<25;x++)target.data[(y*80+x)*4+3]=0;
    target.data.set([0,0,0,255],(13*80+13)*4);
    const [evidence]=inspectScreenBands(target,screen,[{id:'invalid',top:0,bottom:.5}]);
    expect(evidence.reasons).toContain('invalidImage');expect(evidence.rgb).toBeUndefined();
  });
  it('retains bounded raw target preview but discloses sparse highlight clipping before feedback',()=>{
    const target=image();for(let y=0;y<80;y++)for(let x=0;x<4;x++)target.data.set([255,255,255,255],(y*80+x)*4);
    const preview=samplePreviewBands(target,regions);
    expect(preview.bands).toHaveLength(2);expect(preview.targetRejectionReasons).toContain('cameraHighlightClipped');
  });
});
