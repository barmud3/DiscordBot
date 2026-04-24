"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const TEMPLATE_SIZE = 64;
/** Relative scales applied to each slot crop before fingerprinting (query side). */
const QUERY_FINGERPRINT_SCALES = [0.78, 0.88, 1.0, 1.12, 1.24];
/** RGB histogram bins per channel on the slot frame ring (cheap color cue). */
const RING_BINS = 8;
/** Boost ring block so it is not drowned out by the 64×64 gray patch in joint L2 norm. */
const RING_WEIGHT = 3.75;

const SLOTS = [
  "infantry1",
  "infantry2",
  "cavalry1",
  "cavalry2",
  "archery1",
  "archery2",
];

/** @param {string} parenKey */
function mapParenSlotToGearKey(parenKey) {
  const k = String(parenKey).trim().toLowerCase();
  const map = {
    calv1: "cavalry1",
    cav1: "cavalry1",
    cavalry1: "cavalry1",
    calv2: "cavalry2",
    cav2: "cavalry2",
    cavalry2: "cavalry2",
    inf1: "infantry1",
    inf2: "infantry2",
    infantry1: "infantry1",
    infantry2: "infantry2",
    arch1: "archery1",
    arch2: "archery2",
    archery1: "archery1",
    archery2: "archery2",
  };
  return map[k] || null;
}

/**
 * Parse Kingshot-image/*.txt lines like: Hat(calv1) : Purple 3*
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseTrainingLabelFile(text) {
  /** @type {Record<string, string>} */
  const bySlot = {};
  const re = /^\s*[^\s(]+\(([^)]+)\)\s*:\s*(.+?)\s*$/;
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(re);
    if (!m) continue;
    const slot = mapParenSlotToGearKey(m[1]);
    if (!slot) continue;
    bySlot[slot] = m[2].trim();
  }
  return bySlot;
}

/**
 * Map human label text to optimizer step index using the same normalized keys as slash labels.
 * @param {string} raw
 * @param {Record<string, number>} lookup
 */
function labelTextToStep(raw, lookup) {
  let s = String(raw).trim().replace(/\s+/g, " ");
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === "no gear" || lower === "none") return 0;

  /** @type {string[]} */
  const candidates = [s];
  if (/^(green|blue|purple|gold|red)$/i.test(s)) {
    candidates.push(`${s.charAt(0).toUpperCase()}${s.slice(1).toLowerCase()} 0*`);
  }
  if (/^(green|blue|purple|gold|red)\s+t\d+$/i.test(s)) {
    candidates.push(`${s} 0*`);
  }

  for (const c of candidates) {
    const k = c.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (k in lookup) return lookup[k];
  }
  return null;
}

/**
 * Grayscale texture fingerprint (normalized 64×64 patch).
 * @param {Buffer} buf
 */
async function fingerprintSlotCrop(buf) {
  const { data, info } = await sharp(buf)
    .resize(TEMPLATE_SIZE, TEMPLATE_SIZE, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .grayscale()
    .normalize()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const arr = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    arr[i] = data[i] / 255;
    sum += arr[i];
  }
  const mean = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) {
    arr[i] -= mean;
    v += arr[i] * arr[i];
  }
  const std = Math.sqrt(v / n) || 1e-6;
  for (let i = 0; i < n; i++) {
    arr[i] /= std;
  }
  let norm = 0;
  for (let i = 0; i < n; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < n; i++) {
    arr[i] /= norm;
  }
  return arr;
}

/**
 * Normalized RGB histograms (8 bins each) on outer frame ring of the slot crop.
 * @param {Buffer} buf
 */
async function ringRgbHistogram(buf) {
  const { data, info } = await sharp(buf)
    .resize(96, 96, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const ch = info.channels || 3;
  const step = ch >= 4 ? 4 : 3;
  const bx = Math.max(2, Math.floor(w * 0.14));
  const by = Math.max(2, Math.floor(h * 0.14));
  const bins = RING_BINS;
  const hist = new Float32Array(bins * 3);
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const onBorder = x < bx || x >= w - bx || y < by || y >= h - by;
      if (!onBorder) continue;
      const i = (y * w + x) * step;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const br = Math.min(bins - 1, Math.floor((r / 256) * bins));
      const bg = Math.min(bins - 1, Math.floor((g / 256) * bins));
      const bb = Math.min(bins - 1, Math.floor((b / 256) * bins));
      hist[br] += 1;
      hist[bins + bg] += 1;
      hist[2 * bins + bb] += 1;
      count += 1;
    }
  }
  if (count < 6) {
    return new Float32Array(bins * 3);
  }
  for (let i = 0; i < hist.length; i++) hist[i] /= count;
  let norm = 0;
  for (let i = 0; i < hist.length; i++) norm += hist[i] * hist[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < hist.length; i++) hist[i] /= norm;
  return hist;
}

/**
 * Joint fingerprint: mild sharpen → gray patch + weighted ring color histogram, L2-normalized.
 * @param {Buffer} buf
 */
async function richSlotFingerprint(buf) {
  const prep = await sharp(buf).sharpen(0.35, 1, 2).png().toBuffer();
  const gray = await fingerprintSlotCrop(prep);
  const ring = await ringRgbHistogram(prep);
  const dim = gray.length + ring.length;
  const out = new Float32Array(dim);
  out.set(gray, 0);
  const off = gray.length;
  for (let i = 0; i < ring.length; i++) {
    out[off + i] = ring[i] * RING_WEIGHT;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) out[i] /= norm;
  return out;
}

/**
 * @param {Float32Array} a
 * @param {Float32Array} b
 */
function cosineUnitDot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Rich fingerprints at several scales (query side).
 * @param {Buffer} buf
 */
async function richFingerprintsMultiScale(buf) {
  const meta = await sharp(buf).metadata();
  const w0 = meta.width || TEMPLATE_SIZE;
  const h0 = meta.height || TEMPLATE_SIZE;
  /** @type {Float32Array[]} */
  const out = [];
  for (const sc of QUERY_FINGERPRINT_SCALES) {
    const w = Math.max(12, Math.round(w0 * sc));
    const h = Math.max(12, Math.round(h0 * sc));
    const scaled = await sharp(buf)
      .resize(w, h, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .png()
      .toBuffer();
    out.push(await richSlotFingerprint(scaled));
  }
  return out;
}

/**
 * @param {string} templateDir
 * @param {Record<string, number>} lookup
 * @param {(buf: Buffer) => Promise<Record<string, Buffer> | null>} extractSlotCrops
 */
async function loadGovGearTemplateBank(templateDir, lookup, extractSlotCrops) {
  if (!fs.existsSync(templateDir) || !fs.statSync(templateDir).isDirectory()) {
    return null;
  }
  /** @type {Record<string, { step: number, fp: Float32Array }[]>} */
  const bySlot = Object.fromEntries(SLOTS.map((s) => [s, []]));
  let imageCount = 0;
  const names = fs.readdirSync(templateDir);
  const txtFiles = names.filter((f) => f.endsWith(".txt"));
  for (const tf of txtFiles) {
    try {
      const base = path.basename(tf, ".txt");
      const imgExt = [".webp", ".jpg", ".jpeg", ".png"].find((ext) =>
        fs.existsSync(path.join(templateDir, base + ext))
      );
      if (!imgExt) continue;
      const txtPath = path.join(templateDir, tf);
      const imgPath = path.join(templateDir, base + imgExt);
      const text = fs.readFileSync(txtPath, "utf8");
      const labelsBySlot = parseTrainingLabelFile(text);
      const imgBuf = fs.readFileSync(imgPath);
      const crops = await extractSlotCrops(imgBuf);
      if (!crops) continue;
      imageCount += 1;
      for (const slot of SLOTS) {
        const label = labelsBySlot[slot];
        if (!label) continue;
        const step = labelTextToStep(label, lookup);
        if (!Number.isFinite(step)) continue;
        const cropBuf = crops[slot];
        if (!cropBuf) continue;
        const fp = await richSlotFingerprint(cropBuf);
        bySlot[slot].push({ step, fp });
      }
    } catch {
      // Skip unreadable pairs; keep the rest of the bank usable.
    }
  }
  const totalTemplates = SLOTS.reduce((n, s) => n + bySlot[s].length, 0);
  if (totalTemplates === 0) return null;
  return { bySlot, imageCount, templateDir };
}

/**
 * @param {Buffer} gearBuffer
 * @param {Awaited<ReturnType<typeof loadGovGearTemplateBank>>} bank
 * @param
 *   | ((buf: Buffer) => Promise<Record<string, Buffer> | null>)
 *   | Array<(buf: Buffer) => Promise<Record<string, Buffer> | null>>
 *   extractSlotCrops — one cropper or several (bounds / micro-shifts).
 * @param {number} minScore
 */
async function matchGovGearSlotsFromTemplateBank(gearBuffer, bank, extractSlotCrops, minScore) {
  if (!bank) return null;
  const extractors = typeof extractSlotCrops === "function" ? [extractSlotCrops] : extractSlotCrops;
  /** @type {Record<string, number | null>} */
  const pieceLevels = {};
  /** @type {Record<string, number>} */
  const scores = {};
  for (const slot of SLOTS) {
    const list = bank.bySlot[slot];
    let best = -Infinity;
    let bestStep = null;
    if (!list.length) {
      scores[slot] = -1;
      pieceLevels[slot] = null;
      continue;
    }
    for (const ex of extractors) {
      const crops = await ex(gearBuffer);
      if (!crops || !crops[slot]) continue;
      const queryFps = await richFingerprintsMultiScale(crops[slot]);
      for (const t of list) {
        for (const fp of queryFps) {
          const sc = cosineUnitDot(fp, t.fp);
          if (sc > best) {
            best = sc;
            bestStep = t.step;
          }
        }
      }
    }
    scores[slot] = Number.isFinite(best) ? best : -1;
    pieceLevels[slot] = best >= minScore && bestStep !== null ? bestStep : null;
  }
  return { pieceLevels, scores };
}

module.exports = {
  SLOTS,
  loadGovGearTemplateBank,
  matchGovGearSlotsFromTemplateBank,
  parseTrainingLabelFile,
  labelTextToStep,
  /** @type {typeof richFingerprintsMultiScale} */
  richFingerprintsMultiScale,
  /** @type {typeof cosineUnitDot} */
  cosineUnitDot,
};
