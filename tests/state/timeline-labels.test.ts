import { describe, expect, it } from 'vitest';
import { layoutLabels } from '../../src/state/timelineLabels';

describe('layoutLabels', () => {
  it('keeps every label directly under its bar when there is room: all on the first row', () => {
    const spots = layoutLabels(
      [
        { leftPct: 0, widthPx: 150 },
        { leftPct: 50, widthPx: 150 },
      ],
      1000,
    );
    expect(spots).toEqual([
      { xPx: 0, lane: 0 },
      { xPx: 500, lane: 0 },
    ]);
  });

  it('moves a label that would run into the one before onto a second row, still starting under its bar', () => {
    const spots = layoutLabels(
      [
        { leftPct: 10, widthPx: 200 },
        { leftPct: 15, widthPx: 200 },
        { leftPct: 60, widthPx: 200 },
      ],
      1000,
    );
    expect(spots[0]).toEqual({ xPx: 100, lane: 0 });
    expect(spots[1]).toEqual({ xPx: 150, lane: 1 });
    expect(spots[2]).toEqual({ xPx: 600, lane: 0 }); // the first row is free again
  });

  it('shifts a label left just enough to stay inside the timeline', () => {
    expect(layoutLabels([{ leftPct: 95, widthPx: 200 }], 1000)).toEqual([{ xPx: 800, lane: 0 }]);
    expect(layoutLabels([{ leftPct: 0, widthPx: 2000 }], 1000)).toEqual([{ xPx: 0, lane: 0 }]);
  });

  it('does not depend on the order of the list', () => {
    const spots = layoutLabels(
      [
        { leftPct: 50, widthPx: 100 },
        { leftPct: 0, widthPx: 100 },
      ],
      1000,
    );
    expect(spots).toEqual([
      { xPx: 500, lane: 0 },
      { xPx: 0, lane: 0 },
    ]);
  });
});
