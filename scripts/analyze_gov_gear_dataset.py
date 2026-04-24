import argparse
import json
import os
import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np


BASE_W = 403
BASE_H = 875

SLOT_BOXES = {
    "top_left": (34, 194, 84, 84),
    "middle_left": (24, 328, 84, 84),
    "bottom_left": (46, 462, 84, 84),
    "top_right": (273, 194, 84, 84),
    "middle_right": (283, 328, 84, 84),
    "bottom_right": (266, 462, 84, 84),
}

DEFAULT_SLOT_CENTERS = {
    "top_left": (0.150, 0.255),
    "middle_left": (0.105, 0.375),
    "bottom_left": (0.150, 0.495),
    "top_right": (0.850, 0.255),
    "middle_right": (0.895, 0.375),
    "bottom_right": (0.850, 0.495),
}

DEFAULT_SLOT_W_RATIO = 0.19
DEFAULT_SLOT_H_RATIO = 0.125

GEAR_CODE_TO_SLOT = {
    "calv1": "top_left",
    "inf1": "middle_left",
    "arch1": "bottom_left",
    "calv2": "top_right",
    "inf2": "middle_right",
    "arch2": "bottom_right",
}

RARITIES = {"green", "blue", "purple", "gold", "red"}
TIERS = {"regular", "T1", "T2", "T3", "T4", "T5", "T6"}


@dataclass
class ParsedLabel:
    gear_type: str
    gear_code: str
    rarity: str
    tier: str
    stars: int


@dataclass
class Sample:
    sample_id: str
    slot: str
    crop_bgr: np.ndarray
    gray64: np.ndarray
    hsv_hist: np.ndarray
    phash_bits: np.ndarray
    label: ParsedLabel


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def resize_base(img: np.ndarray) -> np.ndarray:
    return cv2.resize(img, (BASE_W, BASE_H), interpolation=cv2.INTER_AREA)


def crop_slot(img_base: np.ndarray, slot: str) -> np.ndarray:
    x, y, w, h = SLOT_BOXES[slot]
    return img_base[y : y + h, x : x + w].copy()


def parse_label_token(label_text: str) -> Tuple[str, str, int]:
    txt = re.sub(r"\s+", " ", label_text.strip())
    parts = txt.split(" ")
    rarity = parts[0].capitalize() if parts else "Unknown"
    rarity_l = rarity.lower()
    if rarity_l not in RARITIES:
        rarity = "Unknown"

    tier_match = re.search(r"\bT([1-6])\b", txt, flags=re.IGNORECASE)
    tier = f"T{tier_match.group(1)}" if tier_match else "regular"
    if tier not in TIERS:
        tier = "regular"

    star_match = re.search(r"([0-3])\*", txt)
    stars = int(star_match.group(1)) if star_match else 0
    return rarity, tier, stars


def parse_dataset_label_line(line: str) -> Optional[ParsedLabel]:
    # Example: Hat(calv1) : Purple 3*
    m = re.match(r"^\s*([^(]+)\(([^)]+)\)\s*:\s*(.+?)\s*$", line)
    if not m:
        return None
    gear_type = m.group(1).strip()
    gear_code = m.group(2).strip()
    label_text = m.group(3).strip()
    rarity, tier, stars = parse_label_token(label_text)
    return ParsedLabel(
        gear_type=gear_type,
        gear_code=gear_code,
        rarity=rarity,
        tier=tier,
        stars=stars,
    )


def preprocess_gray64(crop_bgr: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    gray = cv2.resize(gray, (64, 64), interpolation=cv2.INTER_AREA)
    gray = cv2.equalizeHist(gray)
    return gray


def compute_hsv_hist(crop_bgr: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, [24, 24], [0, 180, 0, 256])
    hist = cv2.normalize(hist, hist).flatten().astype(np.float32)
    return hist


def compute_phash_bits(gray64: np.ndarray) -> np.ndarray:
    resized = cv2.resize(gray64, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    dct = cv2.dct(resized)
    low = dct[:8, :8]
    med = np.median(low)
    return (low > med).astype(np.uint8).flatten()


def load_text_file(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def find_dataset_image(dataset_dir: str, base_name: str) -> Optional[str]:
    for ext in (".webp", ".jpg", ".jpeg", ".png"):
        p = os.path.join(dataset_dir, base_name + ext)
        if os.path.exists(p):
            return p
    return None


def build_layout_slot_boxes(
    img_base: np.ndarray,
    slot_centers: Dict[str, Tuple[float, float]],
    slot_w_ratio: float,
    slot_h_ratio: float,
    padding: int,
    left_shift_x: int,
    left_shift_y: int,
    right_shift_x: int,
    right_shift_y: int,
) -> Dict[str, Tuple[int, int, int, int]]:
    h, w = img_base.shape[:2]
    out: Dict[str, Tuple[int, int, int, int]] = {}
    slot_w = slot_w_ratio * w
    slot_h = slot_h_ratio * h

    for slot in SLOT_BOXES.keys():
        pct = slot_centers.get(slot, DEFAULT_SLOT_CENTERS[slot])
        cx = float(pct[0]) * w
        cy = float(pct[1]) * h
        if slot.endswith("left"):
            cx += left_shift_x
            cy += left_shift_y
        else:
            cx += right_shift_x
            cy += right_shift_y

        x0 = int(round(cx - slot_w / 2.0)) + padding
        x1 = int(round(cx + slot_w / 2.0)) - padding
        y0 = int(round(cy - slot_h / 2.0)) + padding
        y1 = int(round(cy + slot_h / 2.0)) - padding

        x0 = max(0, min(w - 2, x0))
        y0 = max(0, min(h - 2, y0))
        x1 = max(x0 + 1, min(w - 1, x1))
        y1 = max(y0 + 1, min(h - 1, y1))
        out[slot] = (x0, y0, x1 - x0, y1 - y0)
    return out


def load_samples_from_dataset(
    dataset_dir: str,
    slot_centers: Dict[str, Tuple[float, float]],
    slot_w_ratio: float,
    slot_h_ratio: float,
    crop_padding: int,
    left_shift_x: int,
    left_shift_y: int,
    right_shift_x: int,
    right_shift_y: int,
    slot_search_radius: int,
    slot_search_step: int,
    dump_dataset_crops_dir: str = "",
) -> List[Sample]:
    samples: List[Sample] = []
    txt_files = [f for f in os.listdir(dataset_dir) if f.lower().endswith(".txt")]
    txt_files.sort(key=lambda s: (len(s), s))

    for txt_name in txt_files:
        base = os.path.splitext(txt_name)[0]
        img_path = find_dataset_image(dataset_dir, base)
        if not img_path:
            continue
        img = cv2.imread(img_path, cv2.IMREAD_COLOR)
        if img is None:
            continue
        base_img = resize_base(img)
        slot_boxes = build_layout_slot_boxes(
            base_img,
            slot_centers=slot_centers,
            slot_w_ratio=slot_w_ratio,
            slot_h_ratio=slot_h_ratio,
            padding=crop_padding,
            left_shift_x=left_shift_x,
            left_shift_y=left_shift_y,
            right_shift_x=right_shift_x,
            right_shift_y=right_shift_y,
        )
        if dump_dataset_crops_dir:
            per_img_dir = os.path.join(dump_dataset_crops_dir, base)
            ensure_dir(per_img_dir)
            cv2.imwrite(os.path.join(per_img_dir, "overlay-slots.png"), draw_overlay(base_img, slot_boxes))
        txt = load_text_file(os.path.join(dataset_dir, txt_name))
        for line in txt.splitlines():
            parsed = parse_dataset_label_line(line)
            if not parsed:
                continue
            slot = GEAR_CODE_TO_SLOT.get(parsed.gear_code.lower())
            if not slot:
                continue
            x, y, w, h = slot_boxes[slot]
            slot_candidates = [s for s in samples if s.slot == slot]
            # Use the same technique as query crops: local shift search + focus.
            raw_crop, crop = refine_slot_crop_with_local_search(
                base_img=base_img,
                base_box=(x, y, w, h),
                candidates=slot_candidates,
                search_radius=slot_search_radius,
                search_step=slot_search_step,
            )
            if dump_dataset_crops_dir:
                per_img_dir = os.path.join(dump_dataset_crops_dir, base)
                cv2.imwrite(os.path.join(per_img_dir, f"{slot}-raw.png"), raw_crop)
                cv2.imwrite(os.path.join(per_img_dir, f"{slot}.png"), crop)

            gray64 = preprocess_gray64(crop)
            hist = compute_hsv_hist(crop)
            phash_bits = compute_phash_bits(gray64)
            samples.append(
                Sample(
                    sample_id=f"{base}:{parsed.gear_code}",
                    slot=slot,
                    crop_bgr=crop,
                    gray64=gray64,
                    hsv_hist=hist,
                    phash_bits=phash_bits,
                    label=parsed,
                )
            )
    return samples


def build_slot_anchor_templates(samples: List[Sample]) -> Dict[str, np.ndarray]:
    by_slot: Dict[str, List[np.ndarray]] = {k: [] for k in SLOT_BOXES.keys()}
    for s in samples:
        by_slot[s.slot].append(preprocess_gray64(s.crop_bgr))
    out: Dict[str, np.ndarray] = {}
    for slot, arr in by_slot.items():
        if not arr:
            continue
        stack = np.stack(arr, axis=0).astype(np.float32)
        out[slot] = np.median(stack, axis=0).astype(np.uint8)
    return out


def load_layout_config(config_path: str) -> Tuple[Dict[str, Tuple[float, float]], float, float]:
    slot_centers = dict(DEFAULT_SLOT_CENTERS)
    slot_w_ratio = DEFAULT_SLOT_W_RATIO
    slot_h_ratio = DEFAULT_SLOT_H_RATIO

    if not config_path or not os.path.exists(config_path):
        return slot_centers, slot_w_ratio, slot_h_ratio

    with open(config_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    centers = cfg.get("slot_centers", {})
    if isinstance(centers, dict):
        for slot in SLOT_BOXES.keys():
            v = centers.get(slot)
            if isinstance(v, (list, tuple)) and len(v) == 2:
                try:
                    cx = float(v[0])
                    cy = float(v[1])
                    slot_centers[slot] = (cx, cy)
                except (TypeError, ValueError):
                    pass

    try:
        slot_w_ratio = float(cfg.get("slot_w_ratio", slot_w_ratio))
    except (TypeError, ValueError):
        pass
    try:
        slot_h_ratio = float(cfg.get("slot_h_ratio", slot_h_ratio))
    except (TypeError, ValueError):
        pass

    return slot_centers, slot_w_ratio, slot_h_ratio


def focus_slot_inside_raw(raw_crop: np.ndarray) -> np.ndarray:
    h, w = raw_crop.shape[:2]
    if h < 8 or w < 8:
        return raw_crop

    hsv = cv2.cvtColor(raw_crop, cv2.COLOR_BGR2HSV)
    sat_mask = cv2.inRange(hsv, np.array([0, 65, 40], dtype=np.uint8), np.array([179, 255, 255], dtype=np.uint8))

    # Remove tiny red notification dot-like blobs.
    red1 = cv2.inRange(hsv, np.array([0, 110, 80], dtype=np.uint8), np.array([10, 255, 255], dtype=np.uint8))
    red2 = cv2.inRange(hsv, np.array([170, 110, 80], dtype=np.uint8), np.array([179, 255, 255], dtype=np.uint8))
    red_mask = cv2.bitwise_or(red1, red2)
    sat_no_red = cv2.bitwise_and(sat_mask, cv2.bitwise_not(red_mask))
    sat_no_red = cv2.morphologyEx(sat_no_red, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))

    contours, _ = cv2.findContours(sat_no_red, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best_rect = None
    best_score = -1.0
    for c in contours:
        x, y, bw, bh = cv2.boundingRect(c)
        area = bw * bh
        if area < 250:
            continue
        ratio = bw / float(max(1, bh))
        # Mostly square-ish region.
        if ratio < 0.58 or ratio > 1.55:
            continue
        # Prefer larger central blocks.
        cx = x + bw / 2.0
        cy = y + bh / 2.0
        center_score = 1.0 - (abs(cx - (w / 2.0)) / max(1.0, w))
        score = area * (0.75 + 0.25 * center_score)
        if score > best_score:
            best_score = score
            best_rect = (x, y, bw, bh)

    if best_rect is None:
        return raw_crop

    x, y, bw, bh = best_rect
    # Expand to include T label, stars, and small markers/icons.
    pad_l = int(round(0.14 * bw))
    pad_r = int(round(0.14 * bw))
    pad_t = int(round(0.18 * bh))
    pad_b = int(round(0.40 * bh))

    x0 = max(0, x - pad_l)
    y0 = max(0, y - pad_t)
    x1 = min(w, x + bw + pad_r)
    y1 = min(h, y + bh + pad_b)
    if x1 <= x0 + 2 or y1 <= y0 + 2:
        return raw_crop
    return raw_crop[y0:y1, x0:x1].copy()


def detect_slot_boxes_auto(
    img_base: np.ndarray,
    debug_dir: str,
    anchor_templates: Optional[Dict[str, np.ndarray]] = None,
    slot_centers: Optional[Dict[str, Tuple[float, float]]] = None,
    slot_w_ratio: float = DEFAULT_SLOT_W_RATIO,
    slot_h_ratio: float = DEFAULT_SLOT_H_RATIO,
    padding: int = 4,
    left_shift_x: int = 0,
    left_shift_y: int = 0,
    right_shift_x: int = 0,
    right_shift_y: int = 0,
) -> Dict[str, Tuple[int, int, int, int]]:
    # Layout-based center crops (percentage anchors), no contour detection.
    del anchor_templates
    h, w = img_base.shape[:2]
    centers_pct = slot_centers or DEFAULT_SLOT_CENTERS
    out = build_layout_slot_boxes(
        img_base,
        slot_centers=centers_pct,
        slot_w_ratio=slot_w_ratio,
        slot_h_ratio=slot_h_ratio,
        padding=padding,
        left_shift_x=left_shift_x,
        left_shift_y=left_shift_y,
        right_shift_x=right_shift_x,
        right_shift_y=right_shift_y,
    )

    debug = img_base.copy()
    cv2.line(debug, (w // 2, 0), (w // 2, h - 1), (0, 255, 255), 1)
    for slot, (x, y, bw, bh) in out.items():
        color = (255, 180, 0) if slot.endswith("left") else (0, 180, 255)
        cv2.rectangle(debug, (x, y), (x + bw, y + bh), color, 2)
        cv2.putText(debug, slot, (x, max(12, y - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1, cv2.LINE_AA)
    cv2.imwrite(os.path.join(debug_dir, "overlay-slots-detected.png"), debug)
    return out


def template_score(gray_a: np.ndarray, gray_b: np.ndarray) -> float:
    # Inputs are already same size 64x64.
    corr = cv2.matchTemplate(gray_a, gray_b, cv2.TM_CCOEFF_NORMED)
    return float(np.clip(corr.max(), -1.0, 1.0))


def hist_score(hist_a: np.ndarray, hist_b: np.ndarray) -> float:
    # Correlation in [-1,1]
    s = cv2.compareHist(hist_a.astype(np.float32), hist_b.astype(np.float32), cv2.HISTCMP_CORREL)
    return float(np.clip(s, -1.0, 1.0))


def phash_score(bits_a: np.ndarray, bits_b: np.ndarray) -> float:
    dist = int(np.count_nonzero(bits_a != bits_b))
    return 1.0 - (dist / float(len(bits_a)))


def extract_frame_mask(slot_crop: np.ndarray) -> np.ndarray:
    h, w = slot_crop.shape[:2]
    # Focus on side/top frame-local patches (avoid center icon and bottom stars/icons).
    mask = np.zeros((h, w), dtype=np.uint8)
    p = int(round(min(h, w) * 0.18))
    off = int(round(min(h, w) * 0.08))
    # top-left patch
    cv2.rectangle(mask, (off, off), (min(w - 1, off + p), min(h - 1, off + p)), 255, -1)
    # top-right patch
    cv2.rectangle(mask, (max(0, w - off - p - 1), off), (w - off - 1, min(h - 1, off + p)), 255, -1)
    # mid-left patch
    cy0 = int(round(0.34 * h))
    cv2.rectangle(mask, (off, cy0), (min(w - 1, off + p), min(h - 1, cy0 + p)), 255, -1)
    # mid-right patch
    cv2.rectangle(mask, (max(0, w - off - p - 1), cy0), (w - off - 1, min(h - 1, cy0 + p)), 255, -1)
    return mask


def build_rarity_feature(slot_crop: np.ndarray) -> Optional[np.ndarray]:
    h, w = slot_crop.shape[:2]
    if h < 12 or w < 12:
        return None
    hsv = cv2.cvtColor(slot_crop, cv2.COLOR_BGR2HSV)
    mask = extract_frame_mask(slot_crop)

    hue = hsv[:, :, 0]
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    valid = (mask > 0) & (sat > 45) & (val > 35)
    if int(np.count_nonzero(valid)) < 25:
        return None
    hvals = hue[valid].astype(np.float32)
    svals = sat[valid].astype(np.float32) / 255.0
    vvals = val[valid].astype(np.float32) / 255.0

    # Circular hue histogram with moderate bins + sat/val stats.
    hist, _ = np.histogram(hvals, bins=24, range=(0, 180), density=True)
    feat = np.concatenate(
        [
            hist.astype(np.float32),
            np.array(
                [
                    float(np.mean(svals)),
                    float(np.std(svals)),
                    float(np.mean(vvals)),
                    float(np.std(vvals)),
                ],
                dtype=np.float32,
            ),
        ]
    )
    norm = float(np.linalg.norm(feat))
    if norm > 1e-8:
        feat = feat / norm
    return feat


def build_rarity_prototypes(samples: List[Sample]) -> Dict[str, np.ndarray]:
    by_rarity: Dict[str, List[np.ndarray]] = {}
    for s in samples:
        rarity = str(s.label.rarity or "").strip().lower()
        if rarity not in RARITIES:
            continue
        feat = build_rarity_feature(s.crop_bgr)
        if feat is None:
            continue
        by_rarity.setdefault(rarity, []).append(feat)

    out: Dict[str, np.ndarray] = {}
    for rarity, feats in by_rarity.items():
        if not feats:
            continue
        proto = np.mean(np.stack(feats, axis=0), axis=0)
        norm = float(np.linalg.norm(proto))
        if norm > 1e-8:
            proto = proto / norm
        out[rarity] = proto.astype(np.float32)
    return out


def detect_rarity_from_frame(slot_crop: np.ndarray, rarity_prototypes: Dict[str, np.ndarray]) -> Tuple[str, float]:
    feat = build_rarity_feature(slot_crop)
    if feat is None or not rarity_prototypes:
        return "unknown", 0.0
    scored = []
    for rarity, proto in rarity_prototypes.items():
        sim = float(np.dot(feat, proto))
        scored.append((sim, rarity))
    scored.sort(reverse=True, key=lambda t: t[0])
    best_sim, best_rarity = scored[0]
    second_sim = scored[1][0] if len(scored) > 1 else 0.0
    conf = float(np.clip((best_sim - second_sim) * 2.0 + max(0.0, best_sim), 0.0, 1.0))
    return best_rarity, conf


def compute_query_features(query_crop: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    q_gray = preprocess_gray64(query_crop)
    q_hist = compute_hsv_hist(query_crop)
    q_phash = compute_phash_bits(q_gray)
    return q_gray, q_hist, q_phash


def combined_similarity_from_features(
    q_gray: np.ndarray,
    q_hist: np.ndarray,
    q_phash: np.ndarray,
    sample: Sample,
) -> float:
    s_tpl = template_score(q_gray, sample.gray64)
    s_hist = hist_score(q_hist, sample.hsv_hist)
    s_phash = phash_score(q_phash, sample.phash_bits)

    # Normalize from [-1,1] to [0,1] where needed.
    tpl01 = (s_tpl + 1.0) * 0.5
    hist01 = (s_hist + 1.0) * 0.5
    combined = 0.50 * tpl01 + 0.30 * hist01 + 0.20 * s_phash
    return float(np.clip(combined, 0.0, 1.0))


def best_score_for_crop(slot_crop: np.ndarray, candidates: List[Sample]) -> float:
    if not candidates:
        return 0.0
    q_gray, q_hist, q_phash = compute_query_features(slot_crop)
    best = 0.0
    for s in candidates:
        sc = combined_similarity_from_features(q_gray, q_hist, q_phash, s)
        if sc > best:
            best = sc
    return best


def refine_slot_crop_with_local_search(
    base_img: np.ndarray,
    base_box: Tuple[int, int, int, int],
    candidates: List[Sample],
    search_radius: int,
    search_step: int,
) -> Tuple[np.ndarray, np.ndarray]:
    x, y, w, h = base_box
    h_img, w_img = base_img.shape[:2]

    best_raw = base_img[y : y + h, x : x + w].copy()
    best_focus = focus_slot_inside_raw(best_raw)
    best_score = best_score_for_crop(best_focus, candidates)

    if search_radius <= 0 or search_step <= 0:
        return best_raw, best_focus

    for dy in range(-search_radius, search_radius + 1, search_step):
        for dx in range(-search_radius, search_radius + 1, search_step):
            nx = min(max(0, x + dx), max(0, w_img - w))
            ny = min(max(0, y + dy), max(0, h_img - h))
            raw = base_img[ny : ny + h, nx : nx + w].copy()
            focus = focus_slot_inside_raw(raw)
            sc = best_score_for_crop(focus, candidates)
            if sc > best_score:
                best_score = sc
                best_raw = raw
                best_focus = focus
    return best_raw, best_focus


def match_slot(
    slot_name: str,
    slot_crop: np.ndarray,
    samples: List[Sample],
    rarity_prototypes: Dict[str, np.ndarray],
    min_confidence: float,
    min_margin: float,
) -> Dict[str, object]:
    candidates = [s for s in samples if s.slot == slot_name]
    if not candidates:
        return {
            "slot": slot_name,
            "gear_type": "unknown",
            "gear_code": "unknown",
            "rarity": "unknown",
            "tier": "unknown",
            "stars": 0,
            "confidence": 0.0,
            "match_sample": None,
            "status": "unknown_no_candidates",
        }

    rarity_guess, rarity_conf = detect_rarity_from_frame(slot_crop, rarity_prototypes)
    if rarity_guess != "unknown" and rarity_conf >= 0.35:
        filtered = [s for s in candidates if s.label.rarity.lower() == rarity_guess]
        if len(filtered) >= 2:
            candidates = filtered

    q_gray, q_hist, q_phash = compute_query_features(slot_crop)
    scored = []
    for s in candidates:
        score = combined_similarity_from_features(q_gray, q_hist, q_phash, s)
        scored.append((score, s))
    scored.sort(key=lambda x: x[0], reverse=True)

    best_score, best_sample = scored[0]
    top_k = min(5, len(scored))
    top = scored[:top_k]
    label_buckets: Dict[Tuple[str, str, str, str, int], Dict[str, object]] = {}
    for score, sample in top:
        key = (
            sample.label.gear_type,
            sample.label.gear_code,
            sample.label.rarity,
            sample.label.tier,
            int(sample.label.stars),
        )
        bucket = label_buckets.setdefault(
            key,
            {"weight": 0.0, "best_score": 0.0, "best_sample": sample.sample_id},
        )
        weight = float(score * score)
        bucket["weight"] = float(bucket["weight"]) + weight
        if score > float(bucket["best_score"]):
            bucket["best_score"] = float(score)
            bucket["best_sample"] = sample.sample_id

    ranked_labels = sorted(label_buckets.items(), key=lambda kv: float(kv[1]["weight"]), reverse=True)
    best_key, best_bucket = ranked_labels[0]
    second_weight = float(ranked_labels[1][1]["weight"]) if len(ranked_labels) > 1 else 0.0
    total_weight = sum(float(v["weight"]) for _, v in ranked_labels) or 1.0
    support = float(best_bucket["weight"]) / total_weight
    voted_score = float(best_bucket["best_score"])
    confidence = 0.65 * voted_score + 0.35 * support
    margin = float(best_bucket["weight"]) - second_weight
    is_unknown = (confidence < min_confidence) or (margin < min_margin)

    if is_unknown:
        return {
            "slot": slot_name,
            "gear_type": "unknown",
            "gear_code": "unknown",
            "rarity": "unknown",
            "tier": "unknown",
            "stars": 0,
            "confidence": round(float(confidence), 4),
            "match_sample": str(best_bucket["best_sample"]),
            "status": "unknown_low_confidence",
            "margin": round(float(margin), 4),
            "rarity_detected": rarity_guess.capitalize() if rarity_guess != "unknown" else "Unknown",
            "rarity_detected_confidence": round(float(rarity_conf), 4),
        }

    out_rarity = str(best_key[2])
    if rarity_guess != "unknown" and rarity_conf >= 0.35:
        out_rarity = rarity_guess.capitalize()

    return {
        "slot": slot_name,
        "gear_type": str(best_key[0]),
        "gear_code": str(best_key[1]),
        "rarity": out_rarity,
        "tier": str(best_key[3]),
        "stars": int(best_key[4]),
        "confidence": round(float(confidence), 4),
        "match_sample": str(best_bucket["best_sample"]),
        "status": "ok",
        "margin": round(float(margin), 4),
        "rarity_detected": rarity_guess.capitalize() if rarity_guess != "unknown" else "Unknown",
        "rarity_detected_confidence": round(float(rarity_conf), 4),
    }


def draw_overlay(img_base: np.ndarray, slot_boxes: Dict[str, Tuple[int, int, int, int]]) -> np.ndarray:
    out = img_base.copy()
    for name, (x, y, w, h) in slot_boxes.items():
        cv2.rectangle(out, (x, y), (x + w, y + h), (0, 255, 255), 2)
        cv2.putText(out, name, (x, y - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1, cv2.LINE_AA)
    return out


def analyze_full_screenshot(
    input_path: str,
    dataset_dir: str,
    debug_dir: str,
    min_confidence: float,
    min_margin: float,
    left_shift_x: int,
    left_shift_y: int,
    right_shift_x: int,
    right_shift_y: int,
    crop_padding: int,
    config_path: str,
    dump_dataset_crops_dir: str,
    slot_search_radius: int,
    slot_search_step: int,
) -> Dict[str, object]:
    ensure_dir(debug_dir)
    slot_centers, slot_w_ratio, slot_h_ratio = load_layout_config(config_path)
    samples = load_samples_from_dataset(
        dataset_dir=dataset_dir,
        slot_centers=slot_centers,
        slot_w_ratio=slot_w_ratio,
        slot_h_ratio=slot_h_ratio,
        crop_padding=crop_padding,
        left_shift_x=left_shift_x,
        left_shift_y=left_shift_y,
        right_shift_x=right_shift_x,
        right_shift_y=right_shift_y,
        slot_search_radius=slot_search_radius,
        slot_search_step=slot_search_step,
        dump_dataset_crops_dir=dump_dataset_crops_dir,
    )
    if not samples:
        raise RuntimeError(f"No valid samples loaded from dataset dir: {dataset_dir}")
    rarity_prototypes = build_rarity_prototypes(samples)
    anchor_templates = build_slot_anchor_templates(samples)

    img = cv2.imread(input_path, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"Could not read input image: {input_path}")
    # Resize for processing and keep work fully in this coordinate frame.
    base = resize_base(img)
    slot_boxes = detect_slot_boxes_auto(
        base,
        debug_dir,
        anchor_templates=anchor_templates,
        slot_centers=slot_centers,
        slot_w_ratio=slot_w_ratio,
        slot_h_ratio=slot_h_ratio,
        padding=crop_padding,
        left_shift_x=left_shift_x,
        left_shift_y=left_shift_y,
        right_shift_x=right_shift_x,
        right_shift_y=right_shift_y,
    )
    cv2.imwrite(os.path.join(debug_dir, "resized-base.png"), base)
    cv2.imwrite(os.path.join(debug_dir, "overlay-slots-debug.png"), draw_overlay(base, slot_boxes))

    results = []
    unknown_dir = os.path.join(debug_dir, "unknown")
    ensure_dir(unknown_dir)
    candidates_by_slot: Dict[str, List[Sample]] = {slot: [] for slot in SLOT_BOXES.keys()}
    for s in samples:
        candidates_by_slot[s.slot].append(s)
    for slot_name in SLOT_BOXES.keys():
        x, y, w, h = slot_boxes[slot_name]
        raw_crop, focused_crop = refine_slot_crop_with_local_search(
            base_img=base,
            base_box=(x, y, w, h),
            candidates=candidates_by_slot.get(slot_name, []),
            search_radius=slot_search_radius,
            search_step=slot_search_step,
        )

        # Use focused crop for classification.
        slot_result = match_slot(
            slot_name,
            focused_crop,
            samples,
            rarity_prototypes=rarity_prototypes,
            min_confidence=min_confidence,
            min_margin=min_margin,
        )
        if str(slot_result.get("status", "")).startswith("unknown"):
            cv2.imwrite(os.path.join(unknown_dir, f"{slot_name}.png"), focused_crop)
        else:
            cv2.imwrite(os.path.join(debug_dir, f"{slot_name}.png"), focused_crop)
        results.append(slot_result)

    payload = {
        "input": input_path,
        "dataset_dir": dataset_dir,
        "num_samples": len(samples),
        "min_confidence": min_confidence,
        "min_margin": min_margin,
        "results": results,
    }

    with open(os.path.join(debug_dir, "gov-gear-dataset-results.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return payload


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Governor gear analyzer using labeled dataset matching.")
    p.add_argument("--input", required=True, help="Path to full screenshot image (png/jpg/webp).")
    p.add_argument("--dataset-dir", default="Kingshot-image", help="Path to labeled dataset folder.")
    p.add_argument("--debug-dir", default="debug-govgear-output/dataset-match", help="Debug output folder.")
    p.add_argument("--min-confidence", type=float, default=0.57, help="Low-confidence threshold [0..1].")
    p.add_argument("--min-margin", type=float, default=0.03, help="Top1-top2 margin threshold [0..1].")
    p.add_argument("--left-shift-x", type=int, default=0, help="Horizontal shift for left column crops.")
    p.add_argument("--left-shift-y", type=int, default=0, help="Vertical shift for left column crops.")
    p.add_argument("--right-shift-x", type=int, default=0, help="Horizontal shift for right column crops.")
    p.add_argument("--right-shift-y", type=int, default=0, help="Vertical shift for right column crops.")
    p.add_argument("--crop-padding", type=int, default=4, help="Inward padding (pixels) inside each slot box.")
    p.add_argument("--config", default="config.json", help="Path to layout config JSON.")
    p.add_argument(
        "--dump-dataset-crops-dir",
        default="",
        help="Optional directory to export dataset crops/overlays for inspection.",
    )
    p.add_argument(
        "--slot-search-radius",
        type=int,
        default=6,
        help="Per-slot local shift search radius (pixels) for robust alignment.",
    )
    p.add_argument(
        "--slot-search-step",
        type=int,
        default=3,
        help="Per-slot local shift search step (pixels).",
    )
    return p.parse_args()


def main() -> None:
    args = parse_args()
    payload = analyze_full_screenshot(
        input_path=args.input,
        dataset_dir=args.dataset_dir,
        debug_dir=args.debug_dir,
        min_confidence=max(0.0, min(1.0, args.min_confidence)),
        min_margin=max(0.0, min(1.0, args.min_margin)),
        left_shift_x=args.left_shift_x,
        left_shift_y=args.left_shift_y,
        right_shift_x=args.right_shift_x,
        right_shift_y=args.right_shift_y,
        crop_padding=max(0, args.crop_padding),
        config_path=args.config,
        dump_dataset_crops_dir=args.dump_dataset_crops_dir,
        slot_search_radius=max(0, args.slot_search_radius),
        slot_search_step=max(1, args.slot_search_step),
    )
    print(json.dumps(payload["results"], indent=2))


if __name__ == "__main__":
    main()
