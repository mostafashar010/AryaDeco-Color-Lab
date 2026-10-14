import { sampleRegion, type Region } from './sampling';
import type { PixelImage } from './marker';
self.onmessage = (event: MessageEvent<{ id: number; image: PixelImage; offset: { x: number; y: number }; region: Region }>) => {
  try { self.postMessage({ id: event.data.id, result: sampleRegion(event.data.image, event.data.offset, event.data.region) }); }
  catch (error) { self.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : 'خطای نمونه‌برداری' }); }
};
