import argparse
import json
import os
from dataclasses import dataclass
from typing import Dict, Tuple

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

RARITY_HUES = {
    "green": 55,
    "blue": 100,
    "purple": 138,
    "gold": 25,
    "red": 0,
}

TIERS = ["T1", "T2", "T3", "T4", "T5", "T6"]


@dataclass
class SlotResult:
    rarity: str
    tier: str
    stars: int


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def resize_base(img: np.ndarray) -> np.ndarray:
    return cv2.resize(img, (BASE_W, BASE_H), interpolation=cv2.INTER_AREA)


def ring_mask(h: int, w: int, margin_outer: int = 2, margin_inner: int = 15) -> np.ndarray:
    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.rectangle(mask, (margin_outer, margin_outer), (w - margin_outer - 1, h - margin_outer - 1), 255, -1)
    cv2.rectangle(mask, (margin_inner, margin_inner), (w - margin_inner - 1, h - margin_inner - 1), 0, -1)
    return mask


def classify_rarity(slot_bgr: np.ndarray) -> Tuple[str, Dict[str, float], np.ndarray]:
    hsv = cv2.cvtColor(slot_bgr, cv2.COLOR_BGR2HSV)
    h, w = hsv.shape[:2]
    mask = np.zeros((h, w), dtype=np.uint8)
    # Use stable frame strips (avoid bottom stars and center icon content).
    cv2.rectangle(mask, (2, 14), (12, min(h - 1, 66)), 255, -1)  # left frame strip
    cv2.rectangle(mask, (w - 13, 14), (w - 3, min(h - 1, 66)), 255, -1)  # right frame strip
    cv2.rectangle(mask, (14, 2), (min(w - 1, 66), 12), 255, -1)  # top frame strip

    hue = hsv[:, :, 0].astype(np.float32)
    sat = hsv[:, :, 1].astype(np.float32)
    val = hsv[:, :, 2].astype(np.float32)
    valid = (mask > 0) & (sat > 40) & (val > 45)
    if not np.any(valid):
        valid = mask > 0

    hue_vals = hue[valid]
    if hue_vals.size == 0:
        return "blue", {k: 0.0 for k in RARITY_HUES}, mask

    scores = {}
    for rarity, ref in RARITY_HUES.items():
        # Circular hue distance on [0, 180).
        diff = np.abs(hue_vals - ref)
        diff = np.minimum(diff, 180 - diff)
        score = float(np.exp(-np.median(diff) / 10.0))
        scores[rarity] = score

    rarity = max(scores, key=scores.get)
    return rarity, scores, mask


def build_tier_templates() -> Dict[str, np.ndarray]:
    templates = {}
    for t in TIERS:
        canvas = np.zeros((28, 40), dtype=np.uint8)
        cv2.putText(canvas, t, (2, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.7, 255, 2, cv2.LINE_AA)
        _, canvas = cv2.threshold(canvas, 0, 255, cv2.THRESH_BINARY)
        templates[t] = canvas
    return templates


def detect_tier_label_present(tier_roi_bgr: np.ndarray) -> Tuple[bool, np.ndarray]:
    hsv = cv2.cvtColor(tier_roi_bgr, cv2.COLOR_BGR2HSV)
    # Orange-ish label background in top-left corner.
    low = np.array([5, 90, 80], dtype=np.uint8)
    high = np.array([30, 255, 255], dtype=np.uint8)
    mask = cv2.inRange(hsv, low, high)
    mask = cv2.medianBlur(mask, 3)
    present = int(np.count_nonzero(mask)) > 30
    return present, mask


def classify_tier(slot_bgr: np.ndarray, templates: Dict[str, np.ndarray]) -> Tuple[str, Dict[str, float], np.ndarray]:
    roi = slot_bgr[0:30, 0:40].copy()
    label_present, label_mask = detect_tier_label_present(roi)
    if not label_present:
        return "regular", {t: 0.0 for t in TIERS}, label_mask

    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    scores = {}
    for t, tmpl in templates.items():
        resized = cv2.resize(bw, (tmpl.shape[1], tmpl.shape[0]), interpolation=cv2.INTER_AREA)
        m = cv2.matchTemplate(resized, tmpl, cv2.TM_CCOEFF_NORMED)
        scores[t] = float(m.max())

    best_tier = max(scores, key=scores.get)
    best_score = scores[best_tier]

    if best_score >= 0.25:
        return best_tier, scores, bw

    # OCR fallback only when template confidence is too low.
    ocr_tier = ocr_tier_fallback(roi)
    if ocr_tier is not None:
        return ocr_tier, scores, bw
    return best_tier, scores, bw


def ocr_tier_fallback(tier_roi_bgr: np.ndarray) -> str:
    try:
        import pytesseract
    except Exception:
        return None

    gray = cv2.cvtColor(tier_roi_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    try:
        txt = pytesseract.image_to_string(bw, config="--psm 7 -c tessedit_char_whitelist=Tt123456")
    except Exception:
        return None
    txt = (txt or "").strip().upper().replace(" ", "")
    txt = txt.replace("I", "1").replace("L", "1")
    for t in TIERS:
        if t in txt:
            return t
    return None


def classify_stars(slot_bgr: np.ndarray) -> Tuple[int, np.ndarray]:
    h, w = slot_bgr.shape[:2]
    roi = slot_bgr[int(h * 0.70) : h, 0:w]
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)

    # Count bright/saturated bottom markers (yellow stars, green/other ascension markers).
    mask_sat = cv2.inRange(hsv, np.array([0, 85, 80], dtype=np.uint8), np.array([179, 255, 255], dtype=np.uint8))
    mask_yellow = cv2.inRange(hsv, np.array([15, 70, 80], dtype=np.uint8), np.array([45, 255, 255], dtype=np.uint8))
    mask = cv2.bitwise_or(mask_sat, mask_yellow)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))

    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    centers_x = []
    for i in range(1, num_labels):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < 12 or area > 450:
            continue
        x = int(stats[i, cv2.CC_STAT_LEFT] + stats[i, cv2.CC_STAT_WIDTH] / 2)
        centers_x.append(x)

    # Merge near components from the same star.
    centers_x = sorted(centers_x)
    merged = []
    for x in centers_x:
        if not merged or abs(x - merged[-1]) > 8:
            merged.append(x)
    stars = max(0, min(3, len(merged)))
    return stars, mask


def analyze_slot(slot_bgr: np.ndarray, templates: Dict[str, np.ndarray]) -> Tuple[SlotResult, Dict[str, object]]:
    rarity, rarity_scores, rarity_mask = classify_rarity(slot_bgr)
    tier, tier_scores, tier_debug = classify_tier(slot_bgr, templates)
    stars, stars_mask = classify_stars(slot_bgr)
    result = SlotResult(rarity=rarity, tier=tier, stars=stars)
    debug = {
        "rarity_scores": rarity_scores,
        "tier_scores": tier_scores,
        "rarity_mask": rarity_mask,
        "tier_debug": tier_debug,
        "stars_mask": stars_mask,
    }
    return result, debug


def draw_overlay(img: np.ndarray) -> np.ndarray:
    out = img.copy()
    for name, (x, y, w, h) in SLOT_BOXES.items():
        cv2.rectangle(out, (x, y), (x + w, y + h), (0, 255, 255), 2)
        cv2.putText(out, name, (x, y - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1, cv2.LINE_AA)
    return out


def save_debug_slot(debug_dir: str, slot_name: str, slot_bgr: np.ndarray, dbg: Dict[str, object]) -> None:
    ensure_dir(debug_dir)
    cv2.imwrite(os.path.join(debug_dir, f"{slot_name}.png"), slot_bgr)
    cv2.imwrite(os.path.join(debug_dir, f"{slot_name}-rarity-mask.png"), dbg["rarity_mask"])
    cv2.imwrite(os.path.join(debug_dir, f"{slot_name}-tier-debug.png"), dbg["tier_debug"])
    cv2.imwrite(os.path.join(debug_dir, f"{slot_name}-stars-mask.png"), dbg["stars_mask"])


def analyze_image(input_path: str, debug_dir: str) -> Dict[str, Dict[str, object]]:
    img = cv2.imread(input_path, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"Could not read image: {input_path}")

    img_base = resize_base(img)
    ensure_dir(debug_dir)
    cv2.imwrite(os.path.join(debug_dir, "overlay-slots.png"), draw_overlay(img_base))
    cv2.imwrite(os.path.join(debug_dir, "resized-base.png"), img_base)

    templates = build_tier_templates()
    results = {}
    raw_debug_scores = {}

    for slot_name, (x, y, w, h) in SLOT_BOXES.items():
        slot = img_base[y : y + h, x : x + w].copy()
        slot_result, dbg = analyze_slot(slot, templates)
        results[slot_name] = {
            "rarity": slot_result.rarity,
            "tier": slot_result.tier,
            "stars": slot_result.stars,
        }
        raw_debug_scores[slot_name] = {
            "rarity_scores": dbg["rarity_scores"],
            "tier_scores": dbg["tier_scores"],
        }
        save_debug_slot(debug_dir, slot_name, slot, dbg)

    with open(os.path.join(debug_dir, "gov-gear-classification.json"), "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
    with open(os.path.join(debug_dir, "gov-gear-debug-scores.json"), "w", encoding="utf-8") as f:
        json.dump(raw_debug_scores, f, indent=2)
    return results


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Classify Kingshot governor gear slots from screenshot.")
    p.add_argument("--input", required=True, help="Path to full screenshot PNG/JPG")
    p.add_argument(
        "--debug-dir",
        default=os.path.join("debug-govgear-output", "analysis"),
        help="Directory for slot/debug crops and JSON output",
    )
    return p.parse_args()


def main() -> None:
    args = parse_args()
    results = analyze_image(args.input, args.debug_dir)
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
