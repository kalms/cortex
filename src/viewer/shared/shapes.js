/**
 * Canvas 2D drawing primitives for the six node kinds + strike-through overlay.
 *
 * All functions accept (ctx, x, y, r, fillStyle) with an optional `strokeStyle`;
 * they do not set lineWidth (caller decides) except drawStrike which sets 1px.
 * r is the bounding radius; each shape interprets it in a way that gives
 * visually comparable areas.
 */

export function drawCircle(ctx, x, y, r, fill, stroke) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}

export function drawDiamond(ctx, x, y, r, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x,     y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x,     y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}

export function drawHex(ctx, x, y, r, fill, stroke) {
  // Flat-top hexagon, 6 vertices.
  ctx.beginPath();
  const angleOffset = Math.PI / 6;
  for (let i = 0; i < 6; i++) {
    const a = angleOffset + i * (Math.PI / 3);
    const vx = x + r * Math.cos(a);
    const vy = y + r * Math.sin(a);
    if (i === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}

export function drawTri(ctx, x, y, r, fill, stroke) {
  // Equilateral, pointing up. 3 vertices.
  ctx.beginPath();
  ctx.moveTo(x,           y - r);
  ctx.lineTo(x + r * 0.866, y + r * 0.5);
  ctx.lineTo(x - r * 0.866, y + r * 0.5);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}

export function drawPill(ctx, x, y, r, fill, stroke) {
  // Horizontal pill, width 1.8r, height r.
  const halfW = r * 0.9;  // 1.8r / 2
  const halfH = r * 0.5;
  ctx.beginPath();
  ctx.arc(x - halfW + halfH, y, halfH, Math.PI / 2, (3 * Math.PI) / 2);
  ctx.lineTo(x + halfW - halfH, y - halfH);
  ctx.arc(x + halfW - halfH, y, halfH, (3 * Math.PI) / 2, Math.PI / 2);
  ctx.lineTo(x - halfW + halfH, y + halfH);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}

/**
 * Diagonal strike line across a node (used for superseded decisions).
 */
export function drawStrike(ctx, x, y, r, stroke) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x - r, y - r);
  ctx.lineTo(x + r, y + r);
  ctx.lineWidth = 1;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  ctx.restore();
}

/** Dispatcher. kind → draw function. */
export const SHAPE_FOR_KIND = {
  decision:  drawDiamond,
  file:      drawCircle,
  function:  drawCircle,
  component: drawPill,
  reference: drawHex,
  path:      drawTri,
};
