// Layout of the labels under today's timeline bars. Each label would like to start exactly under the left end of its
// bar; labels that would run into the one before are moved down a row, and a label that would run out of the right
// edge is shifted left just enough to fit. All numbers are CSS pixels measured in the browser.

export interface LabelBox {
  /** Where the bar starts, in percent of the timeline's width. */
  leftPct: number;
  /** The label's own width. */
  widthPx: number;
}

export interface LabelSpot {
  xPx: number;
  /** 0 = the row directly under the bars. */
  lane: number;
}

export function layoutLabels(boxes: readonly LabelBox[], containerPx: number, gapPx = 12): LabelSpot[] {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a].leftPct - boxes[b].leftPct || a - b);
  const laneEnds: number[] = [];
  const spots: LabelSpot[] = boxes.map(() => ({ xPx: 0, lane: 0 }));
  for (const i of order) {
    const box = boxes[i];
    const xPx = Math.max(0, Math.min((box.leftPct * containerPx) / 100, containerPx - box.widthPx));
    let lane = laneEnds.findIndex((end) => end + gapPx <= xPx);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = xPx + box.widthPx;
    spots[i] = { xPx, lane };
  }
  return spots;
}
