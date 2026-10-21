import type { Rect } from './marker';
import type { Region } from './sampling';

/**
 * A display aperture that was PROVEN in an earlier frame (separately bounded rim on all four
 * sides, see liveScene `apertureFeedbackSafe`). `heldFrames` counts consecutive frames in which
 * the aperture was NOT re-proven and the anchor was only carried over; it is absent while the
 * anchor is freshly confirmed.
 */
export type DisplayAnchor = { aperture: Region; region: Region; marker: Rect; heldFrames?: number };

/**
 * Longest run of unproven frames a proven aperture may be carried through. The tracking worker
 * processes roughly two frames per second, so this tolerates a ~3 s glare or occlusion and no more.
 */
export const MAX_APERTURE_HOLD_FRAMES = 6;

/** The marker is printed on phone A itself, so an unmoved marker means A has not moved. */
export function sameMarker(a: Rect, b: Rect, tolerance = 1): boolean {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height)) <= tolerance;
}

/**
 * Decide whether a proven anchor may be carried over a frame whose own aperture detection failed
 * (reflection, glare, partial occlusion). Returns the anchor to keep, with `heldFrames` advanced,
 * or undefined when it must be dropped.
 *
 * Callers must already have established: same camera/geometry, cameraMatch mode, and no pixel or
 * surface motion (motion clears the anchor separately). This function additionally requires that
 * the CURRENT frame shows the expected marker at the anchor's position, and enforces the limit.
 */
export function holdAnchor(anchor: DisplayAnchor | undefined, marker: Rect | undefined, limit = MAX_APERTURE_HOLD_FRAMES): DisplayAnchor | undefined {
  if (!anchor || !marker || !sameMarker(marker, anchor.marker)) return undefined;
  const heldFrames = (anchor.heldFrames ?? 0) + 1;
  return heldFrames > limit ? undefined : { ...anchor, heldFrames };
}
