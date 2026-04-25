import argparse
import json
import os
import re
from dataclasses import dataclass
from typing import Dict, List, Tuple

import cv2
import numpy as np


CHARM_API_KEYS = [
    "cavalry_gear_1_charm_1",
    "cavalry_gear_1_charm_2",
    "cavalry_gear_1_charm_3",
    "cavalry_gear_2_charm_1",
    "cavalry_gear_2_charm_2",
    "cavalry_gear_2_charm_3",
    "infantry_gear_1_charm_1",
    "infantry_gear_1_charm_2",
    "infantry_gear_1_charm_3",
    "infantry_gear_2_charm_1",
    "infantry_gear_2_charm_2",
    "infantry_gear_2_charm_3",
    "archery_gear_1_charm_1",
    "archery_gear_1_charm_2",
    "archery_gear_1_charm_3",
    "archery_gear_2_charm_1",
    "archery_gear_2_charm_2",
    "archery_gear_2_charm_3",
]

CHARM_LAYOUT = [
    ("cavalry_gear_1", "Hat (calv1)"),
    ("cavalry_gear_2", "Pendant (calv2)"),
    ("infantry_gear_1", "Shirt (inf1)"),
    ("infantry_gear_2", "Pants (inf2)"),
    ("archery_gear_1", "Ring (arch1)"),
    ("archery_gear_2", "Baton (arch2)"),
]

ROW_KEY_TO_GEAR_KEY = {
    "top_left": "cavalry_gear_1",
    "middle_left": "infantry_gear_1",
    "bottom_left": "archery_gear_1",
    "top_right": "cavalry_gear_2",
    "middle_right": "infantry_gear_2",
    "bottom_right": "archery_gear_2",
}
ROW_CLICK_ORDER = [
    "top_left",
    "middle_left",
    "bottom_left",
    "top_right",
    "middle_right",
    "bottom_right",
]

SLOT_TYPE_BY_GEAR_KEY = {
    "cavalry_gear_1": "cavalry",
    "cavalry_gear_2": "cavalry",
    "infantry_gear_1": "infantry",
    "infantry_gear_2": "infantry",
    "archery_gear_1": "archery",
    "archery_gear_2": "archery",
}


DEFAULT_CONFIG = {
    # Guide screenshot ratios (based on 354x783 screenshots).
    "guide_popup": {"x": 0.075, "y": 0.215, "w": 0.85, "h": 0.61},
    "guide_rows": {"start_y": 0.145, "end_y": 0.985, "count": 6},
    "guide_cols": {
        "start_x": 0.31,
        "spacing": 0.193,
        "w": 0.115,
        "h": 0.085,
        "y_offset": 0.02,
    },
    # Profile screenshot icon anchors (based on 408x887 screenshot).
    "profile_charms": {
        "icon_w": 0.042,
        "icon_h": 0.026,
        "spacing_x": 0.053,
        "row_crop_width_scale": 1.00,
        "row_crop_height_scale": 1.10,
        "cell_crop_width_scale": 0.92,
        "cell_crop_height_scale": 1.00,
        "cloth_anchors": {
            "cavalry_gear_1": {"x": 0.125, "y": 0.292},
            "cavalry_gear_2": {"x": 0.742, "y": 0.292},
            "infantry_gear_1": {"x": 0.125, "y": 0.421},
            "infantry_gear_2": {"x": 0.742, "y": 0.421},
            "archery_gear_1": {"x": 0.125, "y": 0.551},
            "archery_gear_2": {"x": 0.742, "y": 0.551},
        },
        "row_centers_percent": {
            "top_left": {"x": 0.178, "y": 0.305},
            "middle_left": {"x": 0.178, "y": 0.434},
            "bottom_left": {"x": 0.178, "y": 0.564},
            "top_right": {"x": 0.795, "y": 0.305},
            "middle_right": {"x": 0.795, "y": 0.434},
            "bottom_right": {"x": 0.795, "y": 0.564},
        },
    },
    "confidence": {"min_score": 0.42, "min_margin": 0.06},
}


@dataclass
class GuideTemplate:
    level: int
    charm_idx: int
    crop_bgr: np.ndarray
    gray: np.ndarray
    hsv_hist: np.ndarray
    phash_bits: np.ndarray
    source_image: str


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Detect charm levels from profile screenshot using guide screenshot(s) as ground truth."
    )
    p.add_argument("--profile-image", required=True, help="Path to governor profile screenshot.")
    p.add_argument(
        "--calibrate",
        action="store_true",
        help="Calibration mode: click 6 row centers and save percentage coordinates to config.",
    )
    p.add_argument(
        "--guide",
        action="append",
        required=False,
        help=(
            "Guide mapping in format '<path>@<start_level>'. "
            "Example: --guide charm1.png@1 --guide charm2.png@6"
        ),
    )
    p.add_argument(
        "--template-dir",
        default="",
        help=(
            "Optional template dataset dir with level subfolders (e.g. img/Charms/lv1..lv22). "
            "If provided, detector uses those templates instead of guide-image cropping."
        ),
    )
    p.add_argument("--debug-dir", default="debug-charms-output/analysis", help="Where to write debug images/json.")
    p.add_argument("--config", default="", help="Optional JSON config to override default crop ratios.")
    p.add_argument("--config-output", default="", help="Config path to write in calibration mode.")
    p.add_argument(
        "--template-augment",
        type=int,
        default=24,
        help="Synthetic variants per dataset template (small-data booster).",
    )
    return p.parse_args()


def load_config(config_path: str) -> Dict[str, object]:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if not config_path or not os.path.exists(config_path):
        return cfg
    with open(config_path, "r", encoding="utf-8") as f:
        user_cfg = json.load(f)

    def merge(dst: Dict, src: Dict) -> Dict:
        for k, v in src.items():
            if isinstance(v, dict) and isinstance(dst.get(k), dict):
                merge(dst[k], v)
            else:
                dst[k] = v
        return dst

    return merge(cfg, user_cfg)


def parse_guide_specs(specs: List[str]) -> List[Tuple[str, int]]:
    out: List[Tuple[str, int]] = []
    for raw in specs:
        if "@" not in raw:
            raise ValueError(f"Invalid --guide '{raw}'. Expected '<path>@<start_level>'.")
        path, level = raw.rsplit("@", 1)
        path = path.strip()
        if not path:
            raise ValueError(f"Invalid --guide '{raw}': missing file path.")
        try:
            start = int(level.strip())
        except ValueError:
            raise ValueError(f"Invalid --guide '{raw}': start level must be integer.")
        if start < 1 or start > 22:
            raise ValueError(f"Invalid --guide '{raw}': start level must be in 1..22.")
        out.append((path, start))
    return out


def parse_level_from_dir_name(name: str) -> int:
    m = re.search(r"(\d+)", name.lower())
    if not m:
        return -1
    lv = int(m.group(1))
    return lv if 1 <= lv <= 22 else -1


def normalize_template_type(raw_name: str) -> str:
    n = raw_name.lower().strip()
    if n in {"arch", "archer", "archery"}:
        return "archery"
    if n in {"calv", "cavalry", "calvery"}:
        return "cavalry"
    if n in {"inf", "infa", "infantry"}:
        return "infantry"
    return ""


def level_seed(level: int, extra: int) -> int:
    return 1009 * int(level) + 9176 * int(extra) + 1337


def save_config(path_out: str, cfg: Dict[str, object]) -> None:
    ensure_dir(os.path.dirname(path_out) or ".")
    with open(path_out, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)


def normalize_click_points_to_config(points_px: Dict[str, Tuple[int, int]], img_w: int, img_h: int) -> Dict[str, Dict[str, float]]:
    out: Dict[str, Dict[str, float]] = {}
    for key in ROW_CLICK_ORDER:
        x, y = points_px[key]
        out[key] = {"x": round(float(x) / float(img_w), 6), "y": round(float(y) / float(img_h), 6)}
    return out


def derive_row_centers_from_anchors(cfg: Dict[str, object]) -> Dict[str, Dict[str, float]]:
    p_cfg = cfg["profile_charms"]
    icon_w = float(p_cfg["icon_w"])
    icon_h = float(p_cfg["icon_h"])
    spacing_x = float(p_cfg["spacing_x"])
    anchors = p_cfg["cloth_anchors"]
    out: Dict[str, Dict[str, float]] = {}
    for row_key, gear_key in ROW_KEY_TO_GEAR_KEY.items():
        a = anchors[gear_key]
        cx = float(a["x"]) + icon_w + spacing_x
        cy = float(a["y"]) + icon_h * 0.5
        out[row_key] = {"x": round(cx, 6), "y": round(cy, 6)}
    return out


def get_row_centers_percent(cfg: Dict[str, object]) -> Dict[str, Dict[str, float]]:
    p_cfg = cfg.get("profile_charms", {})
    centers = p_cfg.get("row_centers_percent")
    if isinstance(centers, dict) and all(k in centers for k in ROW_CLICK_ORDER):
        return centers
    return derive_row_centers_from_anchors(cfg)


def run_calibration_mode(profile_img: np.ndarray, cfg: Dict[str, object], config_output_path: str) -> None:
    points: Dict[str, Tuple[int, int]] = {}
    h, w = profile_img.shape[:2]
    base = profile_img.copy()
    display = profile_img.copy()
    click_idx = {"i": 0}

    def redraw() -> None:
        nonlocal display
        display = base.copy()
        for i, key in enumerate(ROW_CLICK_ORDER):
            if key in points:
                x, y = points[key]
                cv2.circle(display, (x, y), 5, (0, 255, 255), -1)
                cv2.putText(display, key, (x + 6, y - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
            elif i == click_idx["i"]:
                cv2.putText(
                    display,
                    f"Click: {key}",
                    (12, 28),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.8,
                    (0, 255, 255),
                    2,
                    cv2.LINE_AA,
                )
        cv2.putText(
            display,
            "Click center icon in each row (middle of 3). ENTER=save  BACKSPACE=undo  ESC=cancel",
            (12, h - 14),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.44,
            (235, 235, 235),
            1,
            cv2.LINE_AA,
        )

    def on_mouse(event: int, x: int, y: int, _flags: int, _param: object) -> None:
        if event != cv2.EVENT_LBUTTONDOWN:
            return
        i = click_idx["i"]
        if i >= len(ROW_CLICK_ORDER):
            return
        key = ROW_CLICK_ORDER[i]
        points[key] = (int(np.clip(x, 0, w - 1)), int(np.clip(y, 0, h - 1)))
        click_idx["i"] += 1
        redraw()

    win = "Charm Row Calibration"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)
    cv2.setMouseCallback(win, on_mouse)
    redraw()
    while True:
        cv2.imshow(win, display)
        k = cv2.waitKey(30) & 0xFF
        if k == 27:  # ESC
            cv2.destroyWindow(win)
            raise RuntimeError("Calibration cancelled.")
        if k in (8, 127):  # backspace/delete
            if click_idx["i"] > 0:
                click_idx["i"] -= 1
                points.pop(ROW_CLICK_ORDER[click_idx["i"]], None)
                redraw()
        if k in (13, 10):  # enter
            if click_idx["i"] < len(ROW_CLICK_ORDER):
                continue
            break
    cv2.destroyWindow(win)

    centers = normalize_click_points_to_config(points, w, h)
    cfg.setdefault("profile_charms", {})
    cfg["profile_charms"]["row_centers_percent"] = centers
    save_config(config_output_path, cfg)
    print(f"Saved calibration centers to: {config_output_path}")


def crop_ratio(img: np.ndarray, box: Dict[str, float]) -> np.ndarray:
    h, w = img.shape[:2]
    x0 = int(round(box["x"] * w))
    y0 = int(round(box["y"] * h))
    bw = int(round(box["w"] * w))
    bh = int(round(box["h"] * h))
    x0 = max(0, min(w - 2, x0))
    y0 = max(0, min(h - 2, y0))
    x1 = max(x0 + 1, min(w - 1, x0 + bw))
    y1 = max(y0 + 1, min(h - 1, y0 + bh))
    return img[y0:y1, x0:x1].copy()


def preprocess_gray(crop_bgr: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    gray = cv2.resize(gray, (48, 48), interpolation=cv2.INTER_AREA)
    gray = cv2.equalizeHist(gray)
    return gray


def compute_hsv_hist(crop_bgr: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, [24, 24], [0, 180, 0, 256])
    hist = cv2.normalize(hist, hist).flatten().astype(np.float32)
    return hist


def compute_phash_bits(gray48: np.ndarray) -> np.ndarray:
    img = cv2.resize(gray48, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    dct = cv2.dct(img)
    low = dct[:8, :8]
    med = float(np.median(low))
    return (low > med).astype(np.uint8).flatten()


def template_score(gray_a: np.ndarray, gray_b: np.ndarray) -> float:
    m = cv2.matchTemplate(gray_a, gray_b, cv2.TM_CCOEFF_NORMED)
    return float(np.clip(m.max(), -1.0, 1.0))


def hist_score(hist_a: np.ndarray, hist_b: np.ndarray) -> float:
    s = cv2.compareHist(hist_a.astype(np.float32), hist_b.astype(np.float32), cv2.HISTCMP_CORREL)
    return float(np.clip(s, -1.0, 1.0))


def phash_score(bits_a: np.ndarray, bits_b: np.ndarray) -> float:
    dist = int(np.count_nonzero(bits_a != bits_b))
    return 1.0 - (dist / float(len(bits_a)))


def combined_similarity(q_gray: np.ndarray, q_hist: np.ndarray, q_phash: np.ndarray, tmpl: GuideTemplate) -> float:
    s_tpl = template_score(q_gray, tmpl.gray)
    s_hist = hist_score(q_hist, tmpl.hsv_hist)
    s_ph = phash_score(q_phash, tmpl.phash_bits)
    return float(np.clip(0.55 * ((s_tpl + 1.0) * 0.5) + 0.25 * ((s_hist + 1.0) * 0.5) + 0.20 * s_ph, 0.0, 1.0))


def augment_template_bank(img_bgr: np.ndarray, repeats: int, seed: int = 1337) -> List[np.ndarray]:
    # Conservative augmentations to simulate screenshot variance without changing level shape semantics.
    rng = np.random.default_rng(seed)
    variants = [img_bgr]
    if repeats <= 0:
        return variants
    h, w = img_bgr.shape[:2]
    for _ in range(repeats):
        out = img_bgr.copy()
        alpha = float(rng.uniform(0.90, 1.12))  # contrast
        beta = float(rng.uniform(-14, 14))      # brightness
        out = cv2.convertScaleAbs(out, alpha=alpha, beta=beta)

        if rng.random() < 0.65:
            k = int(rng.choice([3, 5]))
            out = cv2.GaussianBlur(out, (k, k), 0)
        if rng.random() < 0.45:
            q = int(rng.integers(72, 96))
            _, enc = cv2.imencode(".jpg", out, [int(cv2.IMWRITE_JPEG_QUALITY), q])
            out = cv2.imdecode(enc, cv2.IMREAD_COLOR)

        dx = int(rng.integers(-1, 2))
        dy = int(rng.integers(-1, 2))
        m = np.float32([[1, 0, dx], [0, 1, dy]])
        out = cv2.warpAffine(out, m, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        variants.append(out)
    return variants


def extract_guide_templates(guide_specs: List[Tuple[str, int]], cfg: Dict[str, object], debug_dir: str) -> Dict[int, List[GuideTemplate]]:
    out: Dict[int, List[GuideTemplate]] = {0: [], 1: [], 2: []}
    guide_popup = cfg["guide_popup"]
    row_cfg = cfg["guide_rows"]
    col_cfg = cfg["guide_cols"]
    ensure_dir(debug_dir)

    for i, (path, start_level) in enumerate(guide_specs):
        img = cv2.imread(path, cv2.IMREAD_COLOR)
        if img is None:
            raise RuntimeError(f"Could not read guide image: {path}")
        popup = crop_ratio(img, guide_popup)
        cv2.imwrite(os.path.join(debug_dir, f"guide-{i+1}-popup.png"), popup)

        ph, pw = popup.shape[:2]
        y0 = int(round(row_cfg["start_y"] * ph))
        y1 = int(round(row_cfg["end_y"] * ph))
        row_count = int(row_cfg["count"])
        row_h = max(1, (y1 - y0) // row_count)
        icon_w = int(round(col_cfg["w"] * pw))
        icon_h = int(round(col_cfg["h"] * ph))
        cx0 = float(col_cfg["start_x"])
        spacing = float(col_cfg["spacing"])
        y_offset = int(round(col_cfg["y_offset"] * ph))

        overlay = popup.copy()
        for r in range(row_count):
            level = start_level + r
            if level < 1 or level > 22:
                continue
            ry = y0 + r * row_h + y_offset
            for c in range(3):
                cx = int(round((cx0 + c * spacing) * pw))
                x0 = max(0, min(pw - 2, cx))
                yb = max(0, min(ph - 2, ry))
                x1 = max(x0 + 1, min(pw - 1, x0 + icon_w))
                y1b = max(yb + 1, min(ph - 1, yb + icon_h))
                crop = popup[yb:y1b, x0:x1].copy()
                gray = preprocess_gray(crop)
                hist = compute_hsv_hist(crop)
                phash = compute_phash_bits(gray)
                tmpl = GuideTemplate(
                    level=level,
                    charm_idx=c,
                    crop_bgr=crop,
                    gray=gray,
                    hsv_hist=hist,
                    phash_bits=phash,
                    source_image=os.path.basename(path),
                )
                out[c].append(tmpl)
                cv2.rectangle(overlay, (x0, yb), (x1, y1b), (0, 255, 255), 1)
                cv2.putText(
                    overlay,
                    f"L{level}:C{c+1}",
                    (x0, max(10, yb - 2)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.35,
                    (0, 255, 255),
                    1,
                    cv2.LINE_AA,
                )
                cv2.imwrite(os.path.join(debug_dir, f"guide-tmpl-lv{level:02d}-c{c+1}.png"), crop)
        cv2.imwrite(os.path.join(debug_dir, f"guide-{i+1}-overlay.png"), overlay)

    for c in range(3):
        # De-duplicate by keeping best template per level for each column.
        level_map: Dict[int, GuideTemplate] = {}
        for t in out[c]:
            level_map[t.level] = t
        out[c] = [level_map[k] for k in sorted(level_map.keys())]
    return out


def extract_templates_from_dataset(template_dir: str) -> Dict[str, Dict[int, GuideTemplate]]:
    by_type: Dict[str, Dict[int, GuideTemplate]] = {"cavalry": {}, "infantry": {}, "archery": {}}
    if not os.path.isdir(template_dir):
        raise RuntimeError(f"Template dir not found: {template_dir}")

    level_dirs = sorted([d for d in os.listdir(template_dir) if os.path.isdir(os.path.join(template_dir, d))])
    for level_dir in level_dirs:
        level = parse_level_from_dir_name(level_dir)
        if level < 1:
            continue
        full_level_dir = os.path.join(template_dir, level_dir)
        files = sorted([f for f in os.listdir(full_level_dir) if os.path.isfile(os.path.join(full_level_dir, f))])
        for fn in files:
            t = normalize_template_type(os.path.splitext(fn)[0])
            if not t:
                continue
            img_path = os.path.join(full_level_dir, fn)
            img = cv2.imread(img_path, cv2.IMREAD_COLOR)
            if img is None:
                continue
            gray = preprocess_gray(img)
            hist = compute_hsv_hist(img)
            phash = compute_phash_bits(gray)
            by_type[t][level] = GuideTemplate(
                level=level,
                charm_idx=0,
                crop_bgr=img,
                gray=gray,
                hsv_hist=hist,
                phash_bits=phash,
                source_image=os.path.basename(img_path),
            )
    return by_type


def extract_profile_charm_crops(profile_img: np.ndarray, cfg: Dict[str, object], debug_dir: str) -> Dict[str, np.ndarray]:
    out: Dict[str, np.ndarray] = {}
    ensure_dir(debug_dir)
    p_cfg = cfg["profile_charms"]
    h, w = profile_img.shape[:2]
    icon_w = int(round(p_cfg["icon_w"] * w))
    icon_h = int(round(p_cfg["icon_h"] * h))
    spacing_x = int(round(p_cfg["spacing_x"] * w))
    anchors = p_cfg["cloth_anchors"]
    overlay = profile_img.copy()

    for gear_key, _label in CHARM_LAYOUT:
        a = anchors[gear_key]
        x0 = int(round(a["x"] * w))
        y0 = int(round(a["y"] * h))
        for i in range(3):
            xx = x0 + i * spacing_x
            yy = y0
            x1 = max(xx + 1, min(w - 1, xx + icon_w))
            y1 = max(yy + 1, min(h - 1, yy + icon_h))
            xx = max(0, min(w - 2, xx))
            yy = max(0, min(h - 2, yy))
            crop = profile_img[yy:y1, xx:x1].copy()
            key = f"{gear_key}_charm_{i+1}"
            out[key] = crop
            cv2.rectangle(overlay, (xx, yy), (x1, y1), (0, 255, 255), 1)
            cv2.putText(overlay, key, (xx, max(10, yy - 2)), cv2.FONT_HERSHEY_SIMPLEX, 0.28, (0, 255, 255), 1, cv2.LINE_AA)
            cv2.imwrite(os.path.join(debug_dir, f"profile-{key}.png"), crop)

    cv2.imwrite(os.path.join(debug_dir, "profile-overlay.png"), overlay)
    return out


def extract_profile_charm_crops_adaptive(
    profile_img: np.ndarray,
    cfg: Dict[str, object],
    debug_dir: str,
    dataset_templates: Dict[str, Dict[int, GuideTemplate]],
) -> Dict[str, np.ndarray]:
    """Adaptive crop locator: per charm slot, search near expected anchor with template matching."""
    ensure_dir(debug_dir)
    out: Dict[str, np.ndarray] = {}
    p_cfg = cfg["profile_charms"]
    h, w = profile_img.shape[:2]
    icon_w = int(round(p_cfg["icon_w"] * w))
    icon_h = int(round(p_cfg["icon_h"] * h))
    spacing_x = int(round(p_cfg["spacing_x"] * w))
    anchors = p_cfg["cloth_anchors"]
    overlay = profile_img.copy()
    gray_profile = cv2.cvtColor(profile_img, cv2.COLOR_BGR2GRAY)

    win_x = max(6, int(round(icon_w * 1.2)))
    win_y = max(6, int(round(icon_h * 1.4)))

    def best_match_in_window(search_gray: np.ndarray, tmpls: List[np.ndarray]) -> Tuple[float, Tuple[int, int]]:
        best_s = -1.0
        best_xy = (0, 0)
        for t in tmpls:
            resized = cv2.resize(t, (icon_w, icon_h), interpolation=cv2.INTER_AREA)
            if search_gray.shape[0] < icon_h or search_gray.shape[1] < icon_w:
                continue
            m = cv2.matchTemplate(search_gray, resized, cv2.TM_CCOEFF_NORMED)
            _min_val, max_val, _min_loc, max_loc = cv2.minMaxLoc(m)
            if max_val > best_s:
                best_s = float(max_val)
                best_xy = max_loc
        return best_s, best_xy

    for gear_key, _label in CHARM_LAYOUT:
        slot_type = SLOT_TYPE_BY_GEAR_KEY[gear_key]
        base_templates = dataset_templates.get(slot_type, {})
        gray_templates = [preprocess_gray(t.crop_bgr) for _, t in sorted(base_templates.items())]
        if not gray_templates:
            raise RuntimeError(f"No dataset templates for slot type: {slot_type}")

        a = anchors[gear_key]
        anchor_x = int(round(a["x"] * w))
        anchor_y = int(round(a["y"] * h))

        for i in range(3):
            expected_x = anchor_x + i * spacing_x
            expected_y = anchor_y
            sx0 = max(0, expected_x - win_x)
            sy0 = max(0, expected_y - win_y)
            sx1 = min(w, expected_x + icon_w + win_x)
            sy1 = min(h, expected_y + icon_h + win_y)
            search = gray_profile[sy0:sy1, sx0:sx1]
            score, (lx, ly) = best_match_in_window(search, gray_templates)

            x0 = sx0 + lx
            y0 = sy0 + ly
            x0 = max(0, min(w - icon_w, x0))
            y0 = max(0, min(h - icon_h, y0))
            x1 = x0 + icon_w
            y1 = y0 + icon_h
            crop = profile_img[y0:y1, x0:x1].copy()

            key = f"{gear_key}_charm_{i+1}"
            out[key] = crop
            # Search window (blue), expected (red), matched (yellow)
            cv2.rectangle(overlay, (sx0, sy0), (sx1, sy1), (255, 120, 0), 1)
            cv2.rectangle(
                overlay,
                (expected_x, expected_y),
                (min(w - 1, expected_x + icon_w), min(h - 1, expected_y + icon_h)),
                (40, 40, 255),
                1,
            )
            cv2.rectangle(overlay, (x0, y0), (x1, y1), (0, 255, 255), 1)
            cv2.putText(
                overlay,
                f"{key} s={score:.2f}",
                (x0, max(10, y0 - 2)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.28,
                (0, 255, 255),
                1,
                cv2.LINE_AA,
            )
            cv2.imwrite(os.path.join(debug_dir, f"profile-{key}.png"), crop)

    cv2.imwrite(os.path.join(debug_dir, "profile-overlay.png"), overlay)
    return out


def extract_profile_charm_crops_by_row(
    profile_img: np.ndarray,
    cfg: Dict[str, object],
    debug_dir: str,
) -> Dict[str, np.ndarray]:
    """Row-first detector:
    1) detect row of charm blobs under each gear
    2) build one row box
    3) split row into 3 equal crops (left->right)
    """
    ensure_dir(debug_dir)
    out: Dict[str, np.ndarray] = {}
    p_cfg = cfg["profile_charms"]
    h, w = profile_img.shape[:2]
    icon_w = int(round(p_cfg["icon_w"] * w))
    icon_h = int(round(p_cfg["icon_h"] * h))
    spacing_x = int(round(p_cfg["spacing_x"] * w))
    anchors = p_cfg["cloth_anchors"]
    overlay = profile_img.copy()

    win_x = max(8, int(round(icon_w * 1.7)))
    win_y_top = max(6, int(round(icon_h * 1.1)))
    win_y_bottom = max(8, int(round(icon_h * 1.8)))

    min_blob_area = max(10, int(round(icon_w * icon_h * 0.16)))
    max_blob_area = max(min_blob_area + 5, int(round(icon_w * icon_h * 1.6)))
    min_blob_w = max(3, int(round(icon_w * 0.32)))
    max_blob_w = max(min_blob_w + 2, int(round(icon_w * 1.5)))
    min_blob_h = max(3, int(round(icon_h * 0.32)))
    max_blob_h = max(min_blob_h + 2, int(round(icon_h * 1.6)))

    def detect_charm_blobs(win_bgr: np.ndarray) -> List[Tuple[int, int, int, int]]:
        hsv = cv2.cvtColor(win_bgr, cv2.COLOR_BGR2HSV)
        # Small saturated colored icons (green/blue/yellow-ish); keep broad ranges for robustness.
        sat_mask = cv2.inRange(hsv, np.array([0, 55, 40], dtype=np.uint8), np.array([179, 255, 255], dtype=np.uint8))
        # Emphasize colorful spots over brown/gray UI.
        b, g, r = cv2.split(win_bgr)
        colorful = cv2.max(cv2.max(b, g), r) - cv2.min(cv2.min(b, g), r)
        color_mask = cv2.inRange(colorful, 22, 255)
        m = cv2.bitwise_and(sat_mask, color_mask)
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k, iterations=1)
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k, iterations=1)

        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        boxes: List[Tuple[int, int, int, int]] = []
        for c in cnts:
            area = cv2.contourArea(c)
            if area < min_blob_area or area > max_blob_area:
                continue
            x, y, bw, bh = cv2.boundingRect(c)
            if bw < min_blob_w or bw > max_blob_w or bh < min_blob_h or bh > max_blob_h:
                continue
            boxes.append((x, y, bw, bh))
        return boxes

    def choose_best_row(blob_boxes: List[Tuple[int, int, int, int]], expected_y_local: int) -> List[Tuple[int, int, int, int]]:
        if not blob_boxes:
            return []
        centers = []
        for i, (x, y, bw, bh) in enumerate(blob_boxes):
            cx = x + bw / 2.0
            cy = y + bh / 2.0
            centers.append((i, cx, cy))
        row_tol = max(5, int(round(icon_h * 0.65)))
        best_group: List[int] = []
        best_score = -1e9
        for i, _cx, cy in centers:
            group = [j for j, _cx2, cy2 in centers if abs(cy2 - cy) <= row_tol]
            if len(group) < 2:
                continue
            xs = sorted([centers[j][1] for j in group])
            spread = xs[-1] - xs[0] if len(xs) > 1 else 0.0
            spacing_penalty = abs(spread - (2.0 * spacing_x))
            y_mean = float(np.mean([centers[j][2] for j in group]))
            y_penalty = abs(y_mean - expected_y_local)
            # Prefer 3 blobs; allow 2.
            size_bonus = 22.0 if len(group) >= 3 else 8.0
            score = size_bonus - 0.12 * spacing_penalty - 0.35 * y_penalty
            if score > best_score:
                best_score = score
                best_group = group
        if not best_group:
            # Fallback: closest blobs to expected y, up to 3.
            ranked = sorted(centers, key=lambda t: abs(t[2] - expected_y_local))
            best_group = [idx for idx, _cx, _cy in ranked[: min(3, len(ranked))]]
        return [blob_boxes[i] for i in best_group]

    for gear_key, _label in CHARM_LAYOUT:
        a = anchors[gear_key]
        anchor_x = int(round(a["x"] * w))
        anchor_y = int(round(a["y"] * h))
        expected_row_x0 = anchor_x
        expected_row_x1 = anchor_x + icon_w + 2 * spacing_x

        sx0 = max(0, expected_row_x0 - win_x)
        sy0 = max(0, anchor_y - win_y_top)
        sx1 = min(w, expected_row_x1 + win_x)
        sy1 = min(h, anchor_y + icon_h + win_y_bottom)
        win = profile_img[sy0:sy1, sx0:sx1]
        blobs = detect_charm_blobs(win)
        expected_y_local = max(0, min(sy1 - sy0 - 1, anchor_y - sy0 + icon_h * 0.5))
        row_blobs = choose_best_row(blobs, int(expected_y_local))

        # Debug: search window (blue) + blobs (green)
        cv2.rectangle(overlay, (sx0, sy0), (sx1, sy1), (255, 120, 0), 1)
        for x, y, bw, bh in blobs:
            cv2.rectangle(overlay, (sx0 + x, sy0 + y), (sx0 + x + bw, sy0 + y + bh), (0, 200, 0), 1)

        if len(row_blobs) >= 2:
            xs = [x for x, _y, _bw, _bh in row_blobs]
            ys = [_y for _x, _y, _bw, _bh in row_blobs]
            xes = [x + bw for x, _y, bw, _bh in row_blobs]
            yes = [_y + bh for _x, _y, _bw, bh in row_blobs]
            rx0 = sx0 + max(0, min(xs) - int(round(icon_w * 0.35)))
            ry0 = sy0 + max(0, min(ys) - int(round(icon_h * 0.45)))
            rx1 = sx0 + min(win.shape[1], max(xes) + int(round(icon_w * 0.35)))
            ry1 = sy0 + min(win.shape[0], max(yes) + int(round(icon_h * 0.45)))
            # Normalize row box width to approx 3 icons + spacing so split is stable.
            min_row_w = int(round(icon_w * 3.0 + spacing_x * 2.0))
            cur_w = rx1 - rx0
            if cur_w < min_row_w:
                grow = (min_row_w - cur_w) // 2 + 1
                rx0 = max(0, rx0 - grow)
                rx1 = min(w, rx1 + grow)
            # Keep height around icon height.
            target_h = int(round(icon_h * 1.25))
            cy = (ry0 + ry1) // 2
            ry0 = max(0, cy - target_h // 2)
            ry1 = min(h, ry0 + target_h)
        else:
            # Fallback to previous fixed row estimate.
            rx0 = max(0, anchor_x)
            ry0 = max(0, anchor_y)
            rx1 = min(w, anchor_x + icon_w + 2 * spacing_x)
            ry1 = min(h, anchor_y + icon_h)

        # Debug: final detected row box (yellow)
        cv2.rectangle(overlay, (rx0, ry0), (rx1, ry1), (0, 255, 255), 1)
        cv2.putText(
            overlay,
            f"{gear_key}-row",
            (rx0, max(10, ry0 - 2)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.30,
            (0, 255, 255),
            1,
            cv2.LINE_AA,
        )

        row_crop = profile_img[ry0:ry1, rx0:rx1].copy()
        row_w = max(3, row_crop.shape[1])
        row_h = max(1, row_crop.shape[0])
        split_w = row_w / 3.0
        for i in range(3):
            lx0 = int(round(i * split_w))
            lx1 = int(round((i + 1) * split_w))
            lx0 = max(0, min(row_w - 1, lx0))
            lx1 = max(lx0 + 1, min(row_w, lx1))
            charm_crop = row_crop[:, lx0:lx1].copy()
            key = f"{gear_key}_charm_{i+1}"
            out[key] = charm_crop
            # Debug: white split boxes on full image
            gx0 = rx0 + lx0
            gx1 = rx0 + lx1
            cv2.rectangle(overlay, (gx0, ry0), (gx1, ry1), (255, 255, 255), 1)
            cv2.putText(
                overlay,
                key,
                (gx0, min(h - 2, ry1 + 10)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.28,
                (255, 255, 255),
                1,
                cv2.LINE_AA,
            )
            cv2.imwrite(os.path.join(debug_dir, f"profile-{key}.png"), charm_crop)
        cv2.imwrite(os.path.join(debug_dir, f"profile-{gear_key}-row.png"), row_crop)

    cv2.imwrite(os.path.join(debug_dir, "profile-overlay.png"), overlay)
    return out


def extract_profile_charm_crops_by_calibration(
    profile_img: np.ndarray,
    cfg: Dict[str, object],
    debug_dir: str,
) -> Dict[str, np.ndarray]:
    ensure_dir(debug_dir)
    out: Dict[str, np.ndarray] = {}
    p_cfg = cfg["profile_charms"]
    h, w = profile_img.shape[:2]
    icon_w = int(round(float(p_cfg["icon_w"]) * w))
    icon_h = int(round(float(p_cfg["icon_h"]) * h))
    spacing_x = int(round(float(p_cfg["spacing_x"]) * w))
    cell_w = max(4, int(round(icon_w * float(p_cfg.get("cell_crop_width_scale", 0.92)))))
    cell_h = max(4, int(round(icon_h * float(p_cfg.get("cell_crop_height_scale", 1.00)))))
    row_w = int(round((icon_w * 3 + spacing_x * 2) * float(p_cfg.get("row_crop_width_scale", 1.00))))
    row_h = int(round(icon_h * float(p_cfg.get("row_crop_height_scale", 1.10))))
    row_w = max(6, row_w)
    row_h = max(4, row_h)
    centers = get_row_centers_percent(cfg)
    overlay = profile_img.copy()

    for row_key in ROW_CLICK_ORDER:
        gear_key = ROW_KEY_TO_GEAR_KEY[row_key]
        c = centers[row_key]
        cx = int(round(float(c["x"]) * w))
        cy = int(round(float(c["y"]) * h))
        x0 = max(0, min(w - 2, cx - row_w // 2))
        y0 = max(0, min(h - 2, cy - row_h // 2))
        x1 = max(x0 + 1, min(w, x0 + row_w))
        y1 = max(y0 + 1, min(h, y0 + row_h))

        row_crop = profile_img[y0:y1, x0:x1].copy()
        cv2.rectangle(overlay, (x0, y0), (x1, y1), (0, 255, 255), 1)
        cv2.putText(overlay, row_key, (x0, max(10, y0 - 2)), cv2.FONT_HERSHEY_SIMPLEX, 0.34, (0, 255, 255), 1, cv2.LINE_AA)

        # Per-cell crops are centered on calibrated row center +/- spacing, and use icon-sized boxes.
        for i in range(3):
            ccx = cx + (i - 1) * spacing_x
            ccy = cy
            gx0 = max(0, min(w - 2, ccx - cell_w // 2))
            gy0 = max(0, min(h - 2, ccy - cell_h // 2))
            gx1 = max(gx0 + 1, min(w, gx0 + cell_w))
            gy1 = max(gy0 + 1, min(h, gy0 + cell_h))
            charm_crop = profile_img[gy0:gy1, gx0:gx1].copy()
            api_key = f"{gear_key}_charm_{i+1}"
            out[api_key] = charm_crop
            cv2.rectangle(overlay, (gx0, gy0), (gx1, gy1), (255, 255, 255), 1)
            cv2.putText(overlay, f"C{i+1}", (gx0 + 1, gy0 + 10), cv2.FONT_HERSHEY_SIMPLEX, 0.30, (255, 255, 255), 1, cv2.LINE_AA)
            cv2.imwrite(os.path.join(debug_dir, f"profile-{api_key}.png"), charm_crop)
        cv2.imwrite(os.path.join(debug_dir, f"profile-{gear_key}-row.png"), row_crop)

    cv2.imwrite(os.path.join(debug_dir, "profile-overlay.png"), overlay)
    return out


def detect_levels(
    profile_crops: Dict[str, np.ndarray],
    guide_templates: Dict[int, List[GuideTemplate]],
    min_score: float,
    min_margin: float,
) -> Dict[str, Dict[str, object]]:
    results: Dict[str, Dict[str, object]] = {}
    for gear_key, _label in CHARM_LAYOUT:
        for idx in range(3):
            charm_key = f"{gear_key}_charm_{idx+1}"
            crop = profile_crops[charm_key]
            q_gray = preprocess_gray(crop)
            q_hist = compute_hsv_hist(crop)
            q_ph = compute_phash_bits(q_gray)
            tmpls = guide_templates[idx]
            scored: List[Tuple[float, GuideTemplate]] = []
            for t in tmpls:
                s = combined_similarity(q_gray, q_hist, q_ph, t)
                scored.append((s, t))
            scored.sort(key=lambda x: x[0], reverse=True)
            best_score, best_tmpl = scored[0]
            second_score = scored[1][0] if len(scored) > 1 else 0.0
            margin = best_score - second_score
            status = "ok" if (best_score >= min_score and margin >= min_margin) else "low_confidence"
            api_key = f"{gear_key}_charm_{idx+1}"
            results[api_key] = {
                "level": int(best_tmpl.level),
                "confidence": round(float(best_score), 4),
                "margin": round(float(margin), 4),
                "status": status,
                "source": best_tmpl.source_image,
            }
    return results


def build_output(results: Dict[str, Dict[str, object]]) -> Dict[str, object]:
    levels = {k: int(v["level"]) for k, v in results.items()}
    confidences = {k: float(v["confidence"]) for k, v in results.items()}
    statuses = {k: str(v["status"]) for k, v in results.items()}
    unknown = [k for k, v in results.items() if v["status"] != "ok"]
    return {
        "levels": levels,
        "confidences": confidences,
        "statuses": statuses,
        "unknown_slots": unknown,
    }


def main() -> None:
    args = parse_args()
    cfg = load_config(args.config)
    ensure_dir(args.debug_dir)
    guide_specs = parse_guide_specs(args.guide or [])

    profile = cv2.imread(args.profile_image, cv2.IMREAD_COLOR)
    if profile is None:
        raise RuntimeError(f"Could not read profile image: {args.profile_image}")

    if args.calibrate:
        output_path = args.config_output.strip() or args.config.strip() or os.path.join(
            os.path.dirname(__file__), "charm_ocr_calibration.json"
        )
        run_calibration_mode(profile, cfg, output_path)
        return

    c_cfg = cfg["confidence"]

    if args.template_dir:
        dataset_templates = extract_templates_from_dataset(args.template_dir)
        profile_crops = extract_profile_charm_crops_by_calibration(profile, cfg, os.path.join(args.debug_dir, "profile"))
        results = {}
        for gear_key, _label in CHARM_LAYOUT:
            slot_type = SLOT_TYPE_BY_GEAR_KEY[gear_key]
            tmpls = [dataset_templates[slot_type][lv] for lv in sorted(dataset_templates[slot_type].keys())]
            if not tmpls:
                raise RuntimeError(f"No templates found for type '{slot_type}' in {args.template_dir}")

            aug_bank: List[GuideTemplate] = []
            for ti, base_t in enumerate(tmpls):
                aug_imgs = augment_template_bank(base_t.crop_bgr, repeats=max(0, int(args.template_augment)), seed=level_seed(base_t.level, ti))
                for aimg in aug_imgs:
                    g = preprocess_gray(aimg)
                    h = compute_hsv_hist(aimg)
                    p = compute_phash_bits(g)
                    aug_bank.append(
                        GuideTemplate(
                            level=base_t.level,
                            charm_idx=0,
                            crop_bgr=aimg,
                            gray=g,
                            hsv_hist=h,
                            phash_bits=p,
                            source_image=base_t.source_image,
                        )
                    )
            for idx in range(3):
                api_key = f"{gear_key}_charm_{idx+1}"
                crop = profile_crops[api_key]
                q_gray = preprocess_gray(crop)
                q_hist = compute_hsv_hist(crop)
                q_ph = compute_phash_bits(q_gray)
                scored: List[Tuple[float, GuideTemplate]] = []
                for t in aug_bank:
                    scored.append((combined_similarity(q_gray, q_hist, q_ph, t), t))
                scored.sort(key=lambda x: x[0], reverse=True)
                best_score, best_tmpl = scored[0]
                second_score = scored[1][0] if len(scored) > 1 else 0.0
                margin = best_score - second_score
                status = "ok" if (best_score >= float(c_cfg["min_score"]) and margin >= float(c_cfg["min_margin"])) else "low_confidence"
                topk = scored[:10]
                level_votes: Dict[int, List[float]] = {}
                for s, t in topk:
                    level_votes.setdefault(int(t.level), []).append(float(s))
                voted = sorted(
                    ((lv, float(np.mean(vals)), len(vals)) for lv, vals in level_votes.items()),
                    key=lambda x: (x[1], x[2]),
                    reverse=True,
                )
                voted_level, voted_score, voted_count = voted[0]
                voted_margin = voted_score - (voted[1][1] if len(voted) > 1 else 0.0)
                if voted_level != int(best_tmpl.level):
                    # Voting smooths augmentation noise; prefer it over a single top-hit level.
                    best_tmpl = next((t for _s, t in scored if int(t.level) == int(voted_level)), best_tmpl)
                    best_score = voted_score
                    margin = voted_margin
                    status = "ok" if (best_score >= float(c_cfg["min_score"]) and margin >= float(c_cfg["min_margin"])) else "low_confidence"
                results[api_key] = {
                    "level": int(best_tmpl.level),
                    "confidence": round(float(best_score), 4),
                    "margin": round(float(margin), 4),
                    "status": status,
                    "source": best_tmpl.source_image,
                    "vote_count": int(voted_count),
                }
    else:
        if not guide_specs:
            raise RuntimeError("Either --template-dir or at least one --guide must be provided.")
        profile_crops = extract_profile_charm_crops_by_calibration(profile, cfg, os.path.join(args.debug_dir, "profile"))
        guide_templates = extract_guide_templates(guide_specs, cfg, os.path.join(args.debug_dir, "guide"))
        results = detect_levels(
            profile_crops=profile_crops,
            guide_templates=guide_templates,
            min_score=float(c_cfg["min_score"]),
            min_margin=float(c_cfg["min_margin"]),
        )
    payload = {
        "profile_image": args.profile_image,
        "guides": [{"path": p, "start_level": s} for p, s in guide_specs],
        "template_dir": args.template_dir or None,
        "results": results,
        "output": build_output(results),
    }
    out_path = os.path.join(args.debug_dir, "charms-detection.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    print(json.dumps(payload["output"]["levels"], indent=2))


if __name__ == "__main__":
    main()
