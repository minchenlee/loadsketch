// Pointing at a component (the course's focus) moves the canvas only when the card is not in view.
import { describe, expect, it } from 'vitest';
import { inView } from '../src/app/inView.ts';

describe('inView', () => {
  const size = { w: 600, h: 400 };
  it('a card fully on screen is in view; the canvas does not move', () => {
    expect(inView({ x: 100, y: 100, w: 200, h: 60 }, { x: 0, y: 0, zoom: 1 }, size)).toBe(true);
    // pan and zoom count: flow x 500 at zoom 0.5, panned 50 → screen 300..400
    expect(inView({ x: 500, y: 100, w: 200, h: 60 }, { x: 50, y: 0, zoom: 0.5 }, size)).toBe(true);
  });
  it('a card cut by an edge, or outside, is not in view', () => {
    expect(inView({ x: 500, y: 100, w: 200, h: 60 }, { x: 0, y: 0, zoom: 1 }, size)).toBe(false);
    expect(inView({ x: -50, y: 100, w: 200, h: 60 }, { x: 0, y: 0, zoom: 1 }, size)).toBe(false);
    expect(inView({ x: 100, y: 380, w: 200, h: 60 }, { x: 0, y: 0, zoom: 1 }, size)).toBe(false);
  });
  it('a canvas not measured yet (size 0) counts as not in view', () => {
    expect(inView({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, zoom: 1 }, { w: 0, h: 0 })).toBe(false);
  });
});
