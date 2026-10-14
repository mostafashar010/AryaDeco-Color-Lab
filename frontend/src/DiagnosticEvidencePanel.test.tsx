import {render,screen} from '@testing-library/react';
import {describe,it,expect} from 'vitest';
import {DiagnosticEvidencePanel} from './DiagnosticEvidencePanel';
import type {EvidenceSnapshot} from './trace';
const rendered:EvidenceSnapshot={role:'display',stage:'rendered',commandSequence:7,colorSpace:'srgb',rgbEncoding:'encoded',renderedProof:'twoAnimationFrames',status:'renderRequestOnly',physicalAccuracyVerified:false,bands:[{bandIndex:0,driveRgb:[0,.25,1],renderedPaintRgb:[0,64/255,1]}]};
const observed:EvidenceSnapshot={role:'camera',stage:'sampled',commandSequence:7,observedCommandSequence:7,markerSequence:7,presentedFrames:12,rawMediaTime:0,nativeWidth:2160,nativeHeight:2160,analysisWidth:640,analysisHeight:640,colorSpace:'srgb',rgbEncoding:'encoded',bands:[{bandIndex:0,driveRgb:[0,.25,1],targetRgb:[.1,.2,.3],observedRgb:[.12,.22,.32],quality:{status:'accepted',validPixels:100,validBlocks:16}}]};
describe('honest correlated diagnostic evidence view',()=>{
  it('shows commanded rounded CSS and same-frame observation with only encoded RGB difference',()=>{
    render(<DiagnosticEvidencePanel snapshots={[rendered,observed]} currentCommandSequence={7}/>);
    expect(screen.getByLabelText('فرمان و رنگ رندر A')).toHaveTextContent('0.25000');expect(screen.getByLabelText('فرمان و رنگ رندر A')).toHaveTextContent('0.25098');
    expect(screen.getByLabelText('شواهد فریم B')).toHaveTextContent('2160');expect(screen.getByLabelText('شواهد فریم B')).toHaveTextContent('12');
    expect(screen.getByLabelText('اختلاف RGB کدشده نوار 1')).toHaveTextContent('0.02000');
    expect(screen.getByLabelText('شواهد تشخیصی رنگ')).not.toHaveTextContent(/98%|ΔE|HEX/);
  });
  it('withholds measured difference on wrong command rejected quality or mixed encoded domains',()=>{
    const view=render(<DiagnosticEvidencePanel snapshots={[rendered,{...observed,markerSequence:6}]} currentCommandSequence={7}/>);
    expect(screen.queryByLabelText('اختلاف RGB کدشده نوار 1')).not.toBeInTheDocument();
    view.rerender(<DiagnosticEvidencePanel snapshots={[rendered,{...observed,stage:'rejected',rejectionReasons:['cameraShadowClipped'],bands:[{...observed.bands![0],quality:{status:'rejected'}}]}]} currentCommandSequence={7}/>);
    expect(screen.queryByLabelText('اختلاف RGB کدشده نوار 1')).not.toBeInTheDocument();expect(screen.getByText(/cameraShadowClipped/)).toBeInTheDocument();
    view.rerender(<DiagnosticEvidencePanel snapshots={[rendered,{...observed,rgbEncoding:'linear'}]} currentCommandSequence={7}/>);
    expect(screen.queryByLabelText('اختلاف RGB کدشده نوار 1')).not.toBeInTheDocument();
    view.rerender(<DiagnosticEvidencePanel snapshots={[rendered,{...observed,bands:[{...observed.bands![0],driveRgb:[0,.26,1]}]}]} currentCommandSequence={7}/>);
    expect(screen.queryByLabelText('اختلاف RGB کدشده نوار 1')).not.toBeInTheDocument();
  });
});
