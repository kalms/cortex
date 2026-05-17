// src/viewer/layout.js
/**
 * Deterministic grid layout for frames. No physics, no force, no jitter.
 *
 * Input: [{ frame_id, frame_label, member_count }]
 * Output: [{ id, name, count, x, y, w, h }] where x/y are CENTER coordinates.
 *
 * Sort: member_count desc, then frame_id asc. Largest frames fill the
 * top-left, smallest the bottom-right. Each frame sits in a cell sized
 * `stageW/cols × stageH/rows` with 10% inner padding. The frame's size
 * inside the cell scales by sqrt(member_count / max_member_count),
 * clamped to [0.55, 1.0] of the cell content area.
 */
export function gridLayout(frameInputs, stageW, stageH) {
  if (frameInputs.length === 0) return [];

  const sorted = [...frameInputs].sort((a, b) => {
    if (b.member_count !== a.member_count) return b.member_count - a.member_count;
    return a.frame_id - b.frame_id;
  });

  const N = sorted.length;
  const cols = Math.ceil(Math.sqrt(N));
  const rows = Math.ceil(N / cols);
  const cellW = stageW / cols;
  const cellH = stageH / rows;
  const innerW = cellW * 0.8;
  const innerH = cellH * 0.8;
  const maxCount = sorted[0].member_count || 1;

  return sorted.map((f, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = cellW * col + cellW / 2;
    const y = cellH * row + cellH / 2;
    const scale = Math.max(0.55, Math.min(1, Math.sqrt((f.member_count || 1) / maxCount)));
    return {
      id: f.frame_id,
      name: f.frame_label,
      count: f.member_count,
      x,
      y,
      w: innerW * scale,
      h: innerH * scale,
    };
  });
}
