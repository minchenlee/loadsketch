// Pointing at a component (the course's focus, src/app/courseBridge.ts) moves the canvas only
// when the card is not wholly on screen. No DOM: tested in tests/focus-view.test.ts.
/** Whether a card (flow coordinates) is wholly on screen in a canvas of `size` pixels at viewport `vp`. */
export function inView(box: { x: number; y: number; w: number; h: number }, vp: { x: number; y: number; zoom: number }, size: { w: number; h: number }): boolean {
  if (size.w <= 0 || size.h <= 0) return false;
  const left = box.x * vp.zoom + vp.x;
  const top = box.y * vp.zoom + vp.y;
  return left >= 0 && top >= 0 && left + box.w * vp.zoom <= size.w && top + box.h * vp.zoom <= size.h;
}
