"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { richFingerprintsMultiScale, cosineUnitDot } = require("./gov-gear-templates");

const DEFAULT_TEMPLATE_DIR = path.join(__dirname, "..", "img", "gov-resources");

const RESOURCE_KEYS = /** @type {const} */ (["satin", "gildedThreads", "artisansVision"]);
const TEMPLATE_FILES = {
  satin: "satin.png",
  gildedThreads: "gilded-threads.png",
  artisansVision: "artisans-vision.png",
};

/** @param {{ left: number; top: number; width: number; height: number }} rect */
function clampRect(rect, imageW, imageH) {
  const left = Math.max(0, Math.min(imageW - 1, Math.round(rect.left)));
  const top = Math.max(0, Math.min(imageH - 1, Math.round(rect.top)));
  const maxW = Math.max(1, imageW - left);
  const maxH = Math.max(1, imageH - top);
  const width = Math.max(1, Math.min(maxW, Math.round(rect.width)));
  const height = Math.max(1, Math.min(maxH, Math.round(rect.height)));
  return { left, top, width, height };
}

/**
 * Backpack item grid (Other → Backpack), proportional to full screenshot.
 * @param {{ top?: number; left?: number }} [shiftPx] optional pixel nudge (e.g. from shift sweep)
 * @param {{ x?: number; y?: number }} [scale] optional content scale around center
 */
function getBackpackGridLayout(imageW, imageH, shiftPx = {}, scale = {}) {
  const dTop = Number.isFinite(shiftPx.top) ? shiftPx.top : 0;
  const dLeft = Number.isFinite(shiftPx.left) ? shiftPx.left : 0;
  const sx = Number.isFinite(scale.x) ? scale.x : 1;
  const sy = Number.isFinite(scale.y) ? scale.y : 1;
  const base = {
    left: imageW * 0.032,
    top: imageH * 0.115,
    width: imageW * 0.936,
    height: imageH * 0.62,
  };
  const cx = base.left + base.width / 2;
  const cy = base.top + base.height / 2;
  const sw = base.width * sx;
  const sh = base.height * sy;
  const content = clampRect(
    {
      left: cx - sw / 2 + dLeft,
      top: cy - sh / 2 + dTop,
      width: sw,
      height: sh,
    },
    imageW,
    imageH
  );
  const cols = 4;
  const rows = 8;
  const cellW = content.width / cols;
  const cellH = content.height / rows;
  return { content, cols, rows, cellW, cellH };
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function cluster1d(values, tol) {
  if (!values.length) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const groups = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const v = sorted[i];
    const g = groups[groups.length - 1];
    const center = g.reduce((s, x) => s + x, 0) / g.length;
    if (Math.abs(v - center) <= tol) g.push(v);
    else groups.push([v]);
  }
  return groups.map((g) => ({
    center: g.reduce((s, x) => s + x, 0) / g.length,
    count: g.length,
  }));
}

/**
 * Dynamic grid detection:
 * 1) color mask for purple/blue/gold cards
 * 2) connected components (contour-like blobs)
 * 3) filter near-square similarly-sized blobs
 * 4) cluster centers into rows/cols
 * 5) infer layout bounds/cell size
 */
async function detectBackpackGridLayoutDynamic(buffer, imageW, imageH) {
  const rough = getBackpackGridLayout(imageW, imageH, { left: 0, top: 0 }, { x: 1, y: 1 });
  const roi = rough.content;
  let raw;
  try {
    raw = await sharp(buffer).extract(roi).raw().toBuffer({ resolveWithObject: true });
  } catch {
    return null;
  }
  const { data, info } = raw;
  const w = info.width;
  const h = info.height;
  const ch = info.channels || 3;
  const step = ch >= 4 ? 4 : 3;
  if (!w || !h) return null;

  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * step;
      if (isTargetTileColor(data[i], data[i + 1], data[i + 2])) {
        mask[y * w + x] = 1;
      }
    }
  }

  const seen = new Uint8Array(w * h);
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  /** @type {{minX:number; minY:number; maxX:number; maxY:number; bw:number; bh:number; area:number; cx:number; cy:number}[]} */
  const comps = [];
  /** @type {[number, number][]} */
  const q = [];

  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const si = sy * w + sx;
      if (!mask[si] || seen[si]) continue;
      seen[si] = 1;
      q.length = 0;
      q.push([sx, sy]);
      let qi = 0;
      let minX = sx;
      let minY = sy;
      let maxX = sx;
      let maxY = sy;
      let area = 0;
      while (qi < q.length) {
        const [x, y] = q[qi++];
        area += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (const [dx, dy] of dirs) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const ni = ny * w + nx;
          if (!mask[ni] || seen[ni]) continue;
          seen[ni] = 1;
          q.push([nx, ny]);
        }
      }
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      if (area < w * h * 0.006) continue;
      const ratio = bw / Math.max(1, bh);
      if (ratio < 0.62 || ratio > 1.45) continue;
      comps.push({
        minX,
        minY,
        maxX,
        maxY,
        bw,
        bh,
        area,
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
      });
    }
  }

  if (comps.length < 10) return null;
  const medW = median(comps.map((c) => c.bw));
  const medH = median(comps.map((c) => c.bh));
  const keep = comps.filter(
    (c) =>
      c.bw >= medW * 0.68 &&
      c.bw <= medW * 1.45 &&
      c.bh >= medH * 0.68 &&
      c.bh <= medH * 1.45
  );
  if (keep.length < 10) return null;

  const xClusters = cluster1d(
    keep.map((c) => c.cx),
    Math.max(6, medW * 0.46)
  ).sort((a, b) => a.center - b.center);
  const yClusters = cluster1d(
    keep.map((c) => c.cy),
    Math.max(6, medH * 0.46)
  ).sort((a, b) => a.center - b.center);
  if (xClusters.length < 4 || yClusters.length < 5) return null;

  const pickBestContiguous = (clusters, n) => {
    if (clusters.length <= n) return clusters;
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i + n <= clusters.length; i++) {
      const slice = clusters.slice(i, i + n);
      const score = slice.reduce((s, c) => s + c.count, 0);
      if (score > bestScore) {
        bestScore = score;
        best = slice;
      }
    }
    return best || clusters.slice(0, n);
  };

  const colsPicked = pickBestContiguous(xClusters, 4);
  const rowsPicked = pickBestContiguous(yClusters, Math.min(8, yClusters.length));
  const colCenters = colsPicked.map((c) => c.center);
  const rowCenters = rowsPicked.map((r) => r.center);
  const colGaps = [];
  const rowGaps = [];
  for (let i = 1; i < colCenters.length; i++) colGaps.push(colCenters[i] - colCenters[i - 1]);
  for (let i = 1; i < rowCenters.length; i++) rowGaps.push(rowCenters[i] - rowCenters[i - 1]);
  const cellW = median(colGaps) || medW * 1.1;
  const cellH = median(rowGaps) || medH * 1.1;
  const cols = 4;
  const rows = Math.max(6, Math.min(8, rowCenters.length));

  const content = clampRect(
    {
      left: roi.left + colCenters[0] - cellW / 2,
      top: roi.top + rowCenters[0] - cellH / 2,
      width: cellW * cols,
      height: cellH * rows,
    },
    imageW,
    imageH
  );
  return { content, cols, rows, cellW: content.width / cols, cellH: content.height / rows };
}

function cellRectFor(layout, r, c) {
  const { content, cellW, cellH, imageW, imageH } = layout;
  const cellLeft = content.left + c * cellW;
  const cellTop = content.top + r * cellH;
  return clampRect(
    {
      left: cellLeft,
      top: cellTop,
      width: cellW,
      height: cellH,
    },
    imageW,
    imageH
  );
}

function isTargetTileColor(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const sat = mx - mn;
  if (sat < 22 || mx < 55) return false;
  const purple = r > 95 && b > 95 && g < Math.min(r, b) * 0.88;
  const blue = b > 95 && g > 70 && r < g * 0.92 && b > r + 18;
  const gold = r > 120 && g > 78 && b < 96 && r > g * 0.92;
  return purple || blue || gold;
}

/**
 * Detect colored tile bounds (purple/blue/gold) inside one backpack cell.
 * Returns absolute rect or null when no strong color tile is found.
 * @param {Buffer} buffer
 * @param {{ left:number; top:number; width:number; height:number }} cellRect
 * @param {number} imageW
 * @param {number} imageH
 */
async function detectTileRectByColor(buffer, cellRect, imageW, imageH) {
  let raw;
  try {
    raw = await sharp(buffer).extract(cellRect).raw().toBuffer({ resolveWithObject: true });
  } catch {
    return null;
  }
  const { data, info } = raw;
  const w = info.width;
  const h = info.height;
  const ch = info.channels || 3;
  const step = ch >= 4 ? 4 : 3;
  const mask = new Uint8Array(w * h);
  let hits = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * step;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (isTargetTileColor(r, g, b)) {
        mask[y * w + x] = 1;
        hits += 1;
      }
    }
  }
  if (hits < w * h * 0.07) return null;

  // Connected-components on the color mask: pick the best tile-like blob.
  const seen = new Uint8Array(w * h);
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const cxRef = w / 2;
  const cyRef = h / 2;
  let best = null;
  /** @type {[number, number][]} */
  const q = [];

  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const si = sy * w + sx;
      if (!mask[si] || seen[si]) continue;
      seen[si] = 1;
      q.length = 0;
      q.push([sx, sy]);
      let qi = 0;
      let minX = sx;
      let minY = sy;
      let maxX = sx;
      let maxY = sy;
      let area = 0;

      while (qi < q.length) {
        const [x, y] = q[qi++];
        area += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (const [dx, dy] of dirs) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const ni = ny * w + nx;
          if (!mask[ni] || seen[ni]) continue;
          seen[ni] = 1;
          q.push([nx, ny]);
        }
      }

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      if (bw < w * 0.28 || bh < h * 0.28) continue;
      if (area < w * h * 0.04) continue;
      const ratio = bw / Math.max(1, bh);
      // Tile is roughly square-ish; reject long skinny blobs.
      if (ratio < 0.62 || ratio > 1.6) continue;
      const ccx = (minX + maxX) / 2;
      const ccy = (minY + maxY) / 2;
      const dist = Math.hypot(ccx - cxRef, ccy - cyRef) / Math.max(1, Math.min(w, h));
      // Score: prefer larger, centered, square-ish blobs.
      const squareness = 1 - Math.min(1, Math.abs(ratio - 1));
      const score = area * (1 + squareness * 0.6) * (1.2 - Math.min(1, dist));
      if (!best || score > best.score) {
        best = { minX, minY, maxX, maxY, bw, bh, score };
      }
    }
  }

  if (!best) return null;
  // If component is partial (common with gradients/highlights), normalize to a near full-card box.
  let bx = best.minX;
  let by = best.minY;
  let bw = best.bw;
  let bh = best.bh;
  const minW = Math.round(w * 0.64);
  const minH = Math.round(h * 0.64);
  if (bw < minW || bh < minH) {
    const cx = (best.minX + best.maxX) / 2;
    const cy = (best.minY + best.maxY) / 2;
    bw = Math.max(bw, minW);
    bh = Math.max(bh, minH);
    bx = Math.round(cx - bw / 2);
    by = Math.round(cy - bh / 2);
  }
  const padX = Math.round(Math.max(2, bw * 0.12));
  // Asymmetric vertical padding: most residual clipping is on lower edge.
  const padTop = Math.round(Math.max(2, bh * 0.08));
  const padBottom = Math.round(Math.max(3, bh * 0.22));
  return clampRect(
    {
      left: cellRect.left + bx - padX,
      top: cellRect.top + by - padTop,
      width: bw + padX * 2,
      height: bh + padTop + padBottom,
    },
    imageW,
    imageH
  );
}

/**
 * Main icon crop for a grid cell. Uses colored-tile detection first, then fixed fallback.
 * @param {Buffer} buffer
 * @param {{ content:any; cellW:number; cellH:number; imageW:number; imageH:number }} layout
 * @param {number} r
 * @param {number} c
 */
async function iconRectForGridCell(buffer, layout, r, c) {
  const { imageW, imageH } = layout;
  const cell = cellRectFor(layout, r, c);
  const tile = await detectTileRectByColor(buffer, cell, imageW, imageH);
  if (tile) {
    // User requirement: keep the full colored card (purple/blue/gold) in one crop,
    // not a partial top slice that can cut through the middle.
    return clampRect(
      {
        left: tile.left - tile.width * 0.02,
        top: tile.top - tile.height * 0.02,
        width: tile.width * 1.04,
        height: tile.height * 1.04,
      },
      imageW,
      imageH
    );
  }
  // Fallback to geometric crop.
  const mx = cell.width * 0.02;
  const my = cell.height * 0.02;
  return clampRect(
    {
      left: cell.left + mx,
      top: cell.top + my,
      width: cell.width - mx * 2,
      height: cell.height * 0.74,
    },
    imageW,
    imageH
  );
}

/**
 * Multiple crop proposals per cell to reduce sensitivity to one bad crop.
 * @param {Buffer} buffer
 * @param {{ content:any; cellW:number; cellH:number; imageW:number; imageH:number }} layout
 * @param {number} r
 * @param {number} c
 */
async function iconRectProposalsForGridCell(buffer, layout, r, c) {
  const { imageW, imageH } = layout;
  const cell = cellRectFor(layout, r, c);
  /** @type {{ left:number; top:number; width:number; height:number }[]} */
  const rects = [];

  // Proposal 1: color-aware full tile (best when tile segmentation works).
  const colorRect = await iconRectForGridCell(buffer, layout, r, c);
  if (colorRect) rects.push(colorRect);

  // Proposal 2: almost full cell (safe fallback).
  rects.push(
    clampRect(
      {
        left: cell.left + cell.width * 0.04,
        top: cell.top + cell.height * 0.04,
        width: cell.width * 0.92,
        height: cell.height * 0.92,
      },
      imageW,
      imageH
    )
  );

  // Proposal 3: central square (reduces corner noise and adjacent overlap).
  const side = Math.min(cell.width, cell.height) * 0.78;
  const cx = cell.left + cell.width / 2;
  const cy = cell.top + cell.height / 2;
  rects.push(
    clampRect(
      {
        left: cx - side / 2,
        top: cy - side / 2,
        width: side,
        height: side,
      },
      imageW,
      imageH
    )
  );

  // Deduplicate identical rects after clamping.
  const seen = new Set();
  return rects.filter((r0) => {
    const k = `${r0.left},${r0.top},${r0.width},${r0.height}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Prefer layouts where all three icons match; otherwise fall back to strongest partial.
 * @param {Record<string, { r: number; c: number; score: number } | null>} assignments
 * @returns {{ complete: boolean; minScore: number; sumScore: number }}
 */
function assignmentRank(assignments) {
  const parts = RESOURCE_KEYS.map((k) => assignments[k]).filter(Boolean);
  const sumScore = parts.reduce((s, p) => s + p.score, 0);
  if (parts.length < RESOURCE_KEYS.length) {
    return { complete: false, minScore: -Infinity, sumScore };
  }
  return { complete: true, minScore: Math.min(...parts.map((p) => p.score)), sumScore };
}

/** @returns {number} higher is better */
function compareAssignmentRanks(a, b) {
  if (a.complete !== b.complete) return a.complete ? 1 : -1;
  if (a.complete) {
    if (a.minScore !== b.minScore) return a.minScore > b.minScore ? 1 : -1;
    return a.sumScore > b.sumScore ? 1 : a.sumScore < b.sumScore ? -1 : 0;
  }
  return a.sumScore > b.sumScore ? 1 : a.sumScore < b.sumScore ? -1 : 0;
}

/**
 * @param {Awaited<ReturnType<typeof richFingerprintsMultiScale>>} queryFps
 * @param {Awaited<ReturnType<typeof richFingerprintsMultiScale>>} templateFps
 */
function bestCosineAcrossScales(queryFps, templateFps) {
  let best = -1;
  const n = Math.min(queryFps.length, templateFps.length);
  for (let i = 0; i < n; i++) {
    const s = cosineUnitDot(queryFps[i], templateFps[i]);
    if (s > best) best = s;
  }
  return best;
}

function cosineVec(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const den = Math.sqrt(na) * Math.sqrt(nb) || 1e-9;
  return dot / den;
}

/**
 * Build a discriminative icon descriptor:
 * - foreground mask (shape)
 * - edge magnitude map (structure)
 * - grayscale texture (fallback)
 * This is more robust than plain global texture when different items share tile colors.
 * @param {Buffer} buf
 */
async function buildIconDescriptor(buf) {
  const size = 56;
  const { data, info } = await sharp(buf)
    .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const ch = info.channels || 3;
  const step = ch >= 4 ? 4 : 3;

  const corners = [
    0,
    (w - 1) * step,
    ((h - 1) * w) * step,
    ((h - 1) * w + (w - 1)) * step,
  ];
  let br = 0;
  let bg = 0;
  let bb = 0;
  for (const i of corners) {
    br += data[i];
    bg += data[i + 1];
    bb += data[i + 2];
  }
  br /= corners.length;
  bg /= corners.length;
  bb /= corners.length;

  const n = w * h;
  const gray = new Float32Array(n);
  const mask = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * step;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    gray[p] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const dr = r - br;
    const dg = g - bg;
    const db = b - bb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    // Smooth-ish foreground confidence [0,1].
    mask[p] = Math.max(0, Math.min(1, (dist - 18) / 48));
  }

  // Normalize gray (zero-mean unit-norm)
  let gMean = 0;
  for (let i = 0; i < n; i++) gMean += gray[i];
  gMean /= n;
  let gNorm = 0;
  for (let i = 0; i < n; i++) {
    gray[i] -= gMean;
    gNorm += gray[i] * gray[i];
  }
  gNorm = Math.sqrt(gNorm) || 1;
  for (let i = 0; i < n; i++) gray[i] /= gNorm;

  // Simple gradient magnitude map from gray (structure descriptor).
  const edge = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const gx = gray[p + 1] - gray[p - 1];
      const gy = gray[p + w] - gray[p - w];
      edge[p] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  let eNorm = 0;
  for (let i = 0; i < n; i++) eNorm += edge[i] * edge[i];
  eNorm = Math.sqrt(eNorm) || 1;
  for (let i = 0; i < n; i++) edge[i] /= eNorm;

  // Normalize mask too.
  let mNorm = 0;
  for (let i = 0; i < n; i++) mNorm += mask[i] * mask[i];
  mNorm = Math.sqrt(mNorm) || 1;
  for (let i = 0; i < n; i++) mask[i] /= mNorm;

  return { gray, edge, mask };
}

function iconDescriptorScore(queryDesc, templateDesc) {
  const sMask = cosineVec(queryDesc.mask, templateDesc.mask);
  const sEdge = cosineVec(queryDesc.edge, templateDesc.edge);
  const sGray = cosineVec(queryDesc.gray, templateDesc.gray);
  return sMask * 0.52 + sEdge * 0.33 + sGray * 0.15;
}

/**
 * Crop the inner icon so matching depends less on the colored tile background.
 * @param {Buffer} buf
 */
async function cropInnerIcon(buf) {
  const meta = await sharp(buf).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  if (!w || !h) return buf;
  // Keep central area where the item artwork lives; remove frame/background bias.
  const rect = {
    left: Math.max(0, Math.round(w * 0.16)),
    top: Math.max(0, Math.round(h * 0.16)),
    width: Math.max(8, Math.round(w * 0.68)),
    height: Math.max(8, Math.round(h * 0.68)),
  };
  try {
    return await sharp(buf).extract(rect).png().toBuffer();
  } catch {
    return buf;
  }
}

const cellKeyStr = (r, c) => `${r},${c}`;

/**
 * Pick three distinct grid cells (one per resource) to maximize match quality vs greedy key order.
 * @param {{ satin: number; gildedThreads: number; artisansVision: number }[][]} scoreGrid
 */
function optimizeTripleFromScoreGrid(scoreGrid, rows, cols, minScore) {
  const TOP = Math.max(16, rows * cols);
  /** @type {Record<string, { r: number; c: number; score: number }[]>} */
  const lists = { satin: [], gildedThreads: [], artisansVision: [] };
  for (const key of RESOURCE_KEYS) {
    const arr = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        arr.push({ r, c, score: scoreGrid[r][c][key] });
      }
    }
    arr.sort((a, b) => b.score - a.score || a.r - b.r || a.c - b.c);
    const filtered = arr.filter((x) => x.score >= minScore * 0.82);
    lists[key] = (filtered.length ? filtered : arr).slice(0, TOP);
  }

  /** @type {Record<string, { r: number; c: number; score: number } | null> | null} */
  let bestAssign = null;
  let bestMetric = -Infinity;
  for (const a of lists.satin) {
    if (a.score < minScore) break;
    for (const b of lists.gildedThreads) {
      if (b.score < minScore) break;
      if (cellKeyStr(a.r, a.c) === cellKeyStr(b.r, b.c)) continue;
      for (const c of lists.artisansVision) {
        if (c.score < minScore) break;
        if (cellKeyStr(a.r, a.c) === cellKeyStr(c.r, c.c) || cellKeyStr(b.r, b.c) === cellKeyStr(c.r, c.c)) {
          continue;
        }
        const minS = Math.min(a.score, b.score, c.score);
        const sumS = a.score + b.score + c.score;
        const metric = minS * 10000 + sumS;
        if (metric > bestMetric) {
          bestMetric = metric;
          bestAssign = {
            satin: { r: a.r, c: a.c, score: a.score },
            gildedThreads: { r: b.r, c: b.c, score: b.score },
            artisansVision: { r: c.r, c: c.c, score: c.score },
          };
        }
      }
    }
  }
  return bestAssign;
}

/**
 * Prefer the known resource layout pattern in backpack grids:
 * - Gilded Threads (col 1) + Artisan's Vision (col 2) on same row
 * - Satin often at col 4 on same row or one row above
 */
function optimizeBackpackPattern(scoreGrid, rows, cols, minScore) {
  if (cols < 3 || rows < 3) return null;
  let best = null;
  let bestMetric = -Infinity;
  const floor = Math.max(0.1, minScore * 0.72);
  for (let r = 0; r < rows; r++) {
    // Threads + Artisan usually appear as adjacent columns (left->right).
    for (let cPair = 0; cPair <= cols - 2; cPair++) {
      const gt = scoreGrid[r][cPair].gildedThreads;
      const av = scoreGrid[r][cPair + 1].artisansVision;
      if (gt < floor || av < floor) continue;
      // Satin usually appears to the right of that pair (often +2 columns), same or neighboring row.
      for (const rs of [r, r - 1, r + 1]) {
        if (rs < 0 || rs >= rows) continue;
        for (const cS of [cPair + 2, cPair + 3, cols - 1]) {
          if (cS < 0 || cS >= cols) continue;
          const sa = scoreGrid[rs][cS].satin;
          if (sa < floor) continue;
          const minS = Math.min(gt, av, sa);
          const sumS = gt + av + sa;
          // Prefer same-row satin and expected right-side offset.
          const rowPenalty = rs === r ? 0 : 0.06;
          const offsetPenalty = cS === cPair + 2 ? 0 : cS === cPair + 3 ? 0.03 : 0.05;
          const metric = minS * 10000 + (sumS - rowPenalty - offsetPenalty) * 100;
          if (metric > bestMetric) {
            bestMetric = metric;
            best = {
              satin: { r: rs, c: cS, score: sa },
              gildedThreads: { r, c: cPair, score: gt },
              artisansVision: { r, c: cPair + 1, score: av },
              __min: minS,
            };
          }
        }
      }
    }
  }
  if (!best || best.__min < floor) return null;
  return {
    satin: best.satin,
    gildedThreads: best.gildedThreads,
    artisansVision: best.artisansVision,
  };
}

/**
 * @param {{ key: string; r: number; c: number; score: number }[]} ranked
 */
function greedyAssignFromRanked(ranked, minScore) {
  /** @type {Record<string, { r: number; c: number; score: number } | null>} */
  const assignments = { satin: null, gildedThreads: null, artisansVision: null };
  const usedCells = new Set();
  const usedKeys = new Set();
  for (const item of ranked) {
    if (item.score < minScore) break;
    if (usedKeys.has(item.key)) continue;
    const ck = cellKeyStr(item.r, item.c);
    if (usedCells.has(ck)) continue;
    if (assignments[item.key] !== null) continue;
    assignments[item.key] = { r: item.r, c: item.c, score: item.score };
    usedCells.add(ck);
    usedKeys.add(item.key);
    if (usedKeys.size >= RESOURCE_KEYS.length) break;
  }
  return assignments;
}

/**
 * Load reference fingerprints for the three governor backpack resources.
 * @param {string} templateDir
 */
async function loadResourceIconBank(templateDir) {
  if (!fs.existsSync(templateDir) || !fs.statSync(templateDir).isDirectory()) {
    return null;
  }
  /** @type {Record<string, Awaited<ReturnType<typeof richFingerprintsMultiScale>>>} */
  const bank = {};
  /** @type {Record<string, Awaited<ReturnType<typeof richFingerprintsMultiScale>>>} */
  const innerBank = {};
  /** @type {Record<string, Awaited<ReturnType<typeof buildIconDescriptor>>>} */
  const descBank = {};
  for (const key of RESOURCE_KEYS) {
    const fp = path.join(templateDir, TEMPLATE_FILES[key]);
    if (!fs.existsSync(fp)) return null;
    const buf = fs.readFileSync(fp);
    bank[key] = await richFingerprintsMultiScale(buf);
    const inner = await cropInnerIcon(buf);
    innerBank[key] = await richFingerprintsMultiScale(inner);
    descBank[key] = await buildIconDescriptor(buf);
  }
  return { full: bank, inner: innerBank, desc: descBank };
}

/**
 * Score every grid cell against each resource icon in {@link DEFAULT_TEMPLATE_DIR}, then assign
 * the three resources to distinct cells (optimize triple by score, else greedy on ranked pairs).
 * @param {Buffer} buffer
 * @param {{ templateDir?: string; minScore?: number; gridShiftSweep?: boolean; includeScoreGrid?: boolean; gridScaleSweep?: boolean }} [opts]
 * @returns {Promise<null | { assignments: Record<string, { r: number; c: number; score: number } | null>; layout: object; ranked: { key: string; r: number; c: number; score: number }[]; scoreGrid?: { satin:number; gildedThreads:number; artisansVision:number }[][] }>}
 */
async function matchBackpackResourceCells(buffer, opts = {}) {
  const templateDir = (opts.templateDir || "").trim() || DEFAULT_TEMPLATE_DIR;
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0.19;
  const gridShiftSweep = opts.gridShiftSweep !== false;
  // Scale sweep is expensive; keep it opt-in for deep debugging.
  const gridScaleSweep = opts.gridScaleSweep === true;
  const includeScoreGrid = opts.includeScoreGrid === true;

  const meta = await sharp(buffer).metadata();
  const imageW = meta.width || 0;
  const imageH = meta.height || 0;
  if (!imageW || !imageH) return null;

  const bank = await loadResourceIconBank(templateDir);
  if (!bank) return null;

  /** @param {{ content: { left: number; top: number; width: number; height: number }; cols: number; rows: number; cellW: number; cellH: number }} layout */
  async function runOneGridMatch(layout) {
    const { content, cols, rows, cellW, cellH } = layout;
    const layoutWithImage = { ...layout, imageW, imageH };
    /** @type {{ satin: number; gildedThreads: number; artisansVision: number }[][]} */
    const scoreGrid = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({
        satin: -1,
        gildedThreads: -1,
        artisansVision: -1,
      }))
    );

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const proposals = await iconRectProposalsForGridCell(buffer, layoutWithImage, r, c);
        /** @type {Record<string, number>} */
        const bestByKey = { satin: -1, gildedThreads: -1, artisansVision: -1 };

        for (const iconRect of proposals) {
          let iconBuf;
          try {
            iconBuf = await sharp(buffer).extract(iconRect).png().toBuffer();
          } catch {
            continue;
          }
          let queryFps;
          let queryInnerFps;
          let queryDesc;
          try {
            queryFps = await richFingerprintsMultiScale(iconBuf);
            const innerIconBuf = await cropInnerIcon(iconBuf);
            queryInnerFps = await richFingerprintsMultiScale(innerIconBuf);
            queryDesc = await buildIconDescriptor(iconBuf);
          } catch {
            continue;
          }
          for (const key of RESOURCE_KEYS) {
            const fullScore = bestCosineAcrossScales(queryFps, bank.full[key]);
            const innerScore = bestCosineAcrossScales(queryInnerFps, bank.inner[key]);
            const descScore = iconDescriptorScore(queryDesc, bank.desc[key]);
            // New analyzer: prioritize shape/edges to separate same-colored different icons.
            const score = descScore * 0.6 + innerScore * 0.3 + fullScore * 0.1;
            if (score > bestByKey[key]) bestByKey[key] = score;
          }
        }

        for (const key of RESOURCE_KEYS) {
          scoreGrid[r][c][key] = bestByKey[key];
        }
      }
    }

    /** @type {{ key: string; r: number; c: number; score: number }[]} */
    const ranked = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        for (const key of RESOURCE_KEYS) {
          const score = scoreGrid[r][c][key];
          if (score >= minScore * 0.85) {
            ranked.push({ key, r, c, score });
          }
        }
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.r - b.r || a.c - b.c);

    const patternOptimized = optimizeBackpackPattern(scoreGrid, rows, cols, minScore);
    const optimized = patternOptimized || optimizeTripleFromScoreGrid(scoreGrid, rows, cols, minScore);
    /** @type {Record<string, { r: number; c: number; score: number } | null>} */
    let assignments;
    if (
      optimized &&
      RESOURCE_KEYS.every((k) => optimized[k] && optimized[k].score >= minScore)
    ) {
      assignments = optimized;
    } else {
      assignments = greedyAssignFromRanked(ranked, minScore);
    }

    const any = RESOURCE_KEYS.some((k) => assignments[k] !== null);
    const layoutOut = { content, cols, rows, cellW, cellH, imageW, imageH };
    if (!any) return null;
    if (includeScoreGrid) {
      return { assignments, layout: layoutOut, ranked, scoreGrid };
    }
    return { assignments, layout: layoutOut, ranked };
  }

  // Try dynamic grid detection first (contours/components + row/col clustering).
  const dynamicLayout = await detectBackpackGridLayoutDynamic(buffer, imageW, imageH);
  if (dynamicLayout) {
    const dynamicResult = await runOneGridMatch(dynamicLayout);
    if (dynamicResult) return dynamicResult;
  }

  /** Fractions of image height to nudge grid top (handles status bar / crop variance). */
  const verticalFracs = gridShiftSweep ? [0, -0.018, 0.018, -0.036, 0.036, -0.054, 0.054] : [0];
  /** Horizontal sweep is needed for screenshots with side crop / UI safe-area offsets. */
  const horizontalFracs = gridShiftSweep ? [0, -0.014, 0.014, -0.028, 0.028] : [0];
  /** Slight content scale sweep to handle device aspect ratio / pinch differences. */
  const scaleVals = gridScaleSweep ? [1, 0.985, 1.015, 0.97, 1.03] : [1];

  let best = null;
  /** @type {ReturnType<typeof assignmentRank> | null} */
  let bestRank = null;

  for (const fv of verticalFracs) {
    for (const fh of horizontalFracs) {
      for (const sx of scaleVals) {
        for (const sy of scaleVals) {
          const layout = getBackpackGridLayout(
            imageW,
            imageH,
            {
              top: Math.round(fv * imageH),
              left: Math.round(fh * imageW),
            },
            { x: sx, y: sy }
          );
          const result = await runOneGridMatch(layout);
          if (!result) continue;
          const rank = assignmentRank(result.assignments);
          if (!bestRank || compareAssignmentRanks(rank, bestRank) > 0) {
            bestRank = rank;
            best = result;
          }
        }
      }
    }
  }

  return best;
}

/**
 * Number strip at bottom of a matched grid cell.
 */
function numberRectForAssignment(layout, assignment) {
  const { content, cellW, cellH, imageW, imageH } = layout;
  const { r, c } = assignment;
  const cellLeft = content.left + c * cellW;
  const cellTop = content.top + r * cellH;
  return clampRect(
    {
      // Keep a wider/taller strip so OCR sees full comma-separated counts.
      left: cellLeft + cellW * 0.03,
      top: cellTop + cellH * 0.62,
      width: cellW * 0.94,
      height: cellH * 0.36,
    },
    imageW,
    imageH
  );
}

module.exports = {
  RESOURCE_KEYS,
  DEFAULT_TEMPLATE_DIR,
  matchBackpackResourceCells,
  numberRectForAssignment,
  getBackpackGridLayout,
  iconRectForGridCell,
  detectBackpackGridLayoutDynamic,
};
