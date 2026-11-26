// The phone's bottom sheet (src/app/phone.ts): one source for what it shows.
import { describe, expect, it } from 'vitest';
import { closeSheet, pickTab, sheetOf } from '../src/app/phone.ts';

describe('phone sheet', () => {
  it('shows the find-limit panel while it is open, over any drawer', () => {
    expect(sheetOf({ drawer: null, limitOpen: true })).toBe('limit');
    expect(sheetOf({ drawer: 'inspector', limitOpen: true })).toBe('limit');
  });
  it('else the drawer of the tab, or nothing', () => {
    expect(sheetOf({ drawer: 'metrics', limitOpen: false })).toBe('metrics');
    expect(sheetOf({ drawer: null, limitOpen: false })).toBeNull();
  });
  it('an already open panel shows when the phone layout comes (no transition needed)', () => {
    // the desktop opened Find limit; the window gets narrow: the same state is the limit sheet
    expect(sheetOf({ drawer: null, limitOpen: true })).toBe('limit');
  });
  it('closing the sheet closes the panel and the drawer under it', () => {
    expect(closeSheet()).toEqual({ drawer: null, limitOpen: false });
    expect(sheetOf(closeSheet())).toBeNull();
  });
  it('a tab shows its drawer and ends a search; the tab that shows closes it', () => {
    expect(pickTab({ drawer: null, limitOpen: true }, 'inspector')).toEqual({ drawer: 'inspector', limitOpen: false });
    expect(pickTab({ drawer: 'inspector', limitOpen: true }, 'inspector')).toEqual({ drawer: 'inspector', limitOpen: false });
    expect(pickTab({ drawer: 'inspector', limitOpen: false }, 'inspector')).toEqual({ drawer: null, limitOpen: false });
    expect(pickTab({ drawer: 'palette', limitOpen: false }, 'metrics')).toEqual({ drawer: 'metrics', limitOpen: false });
  });
});
