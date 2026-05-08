"""
핵심문제 페이지에서 문제별 크롭 좌표 추출 → problem_crops.json
실행: python scripts/extract_crops.py
"""
import fitz, json, re, sys
sys.stdout.reconfigure(encoding="utf-8")
from pathlib import Path

PDF_PATH   = Path(r"g:\내 드라이브\Main\2026\건축기사\실기\구조\건축기사 구조_ocr.pdf")
PAGES_JSON = Path(__file__).parent.parent / "static" / "data" / "problem_pages.json"
OUTPUT     = Path(__file__).parent.parent / "static" / "data" / "problem_crops.json"

CHAPTER_META = {
    "ch1-1":  ("힘의 합성과 회전",     "구조역학",           "#4A90D9"),
    "ch1-2":  ("힘의 평형",             "구조역학",           "#4A90D9"),
    "ch1-3":  ("지점반력",               "구조역학",           "#4A90D9"),
    "ch1-4":  ("전단력·휨모멘트",       "구조역학",           "#4A90D9"),
    "ch1-5":  ("트러스 구조해석",       "구조역학",           "#4A90D9"),
    "ch1-6":  ("단면의 성질",           "구조역학",           "#4A90D9"),
    "ch1-7":  ("응력과 변형률",         "구조역학",           "#4A90D9"),
    "ch1-8":  ("보의 휨변형",           "구조역학",           "#4A90D9"),
    "ch1-9":  ("기둥",                   "구조역학",           "#4A90D9"),
    "ch1-10": ("부정정구조",             "구조역학",           "#4A90D9"),
    "ch2-1":  ("RC 해석과 설계의 원칙", "철근콘크리트구조",   "#E8644A"),
    "ch2-2":  ("RC구조해석 일반사항",   "철근콘크리트구조",   "#E8644A"),
    "ch2-3":  ("RC 단철근 보 해석",     "철근콘크리트구조",   "#E8644A"),
    "ch2-4":  ("RC 전단설계",           "철근콘크리트구조",   "#E8644A"),
    "ch2-5":  ("RC 슬래브",             "철근콘크리트구조",   "#E8644A"),
    "ch2-6":  ("RC구조 사용성",         "철근콘크리트구조",   "#E8644A"),
    "ch2-7":  ("RC구조 철근 상세",      "철근콘크리트구조",   "#E8644A"),
    "ch3-1":  ("강구조 일반사항",       "강구조",             "#5DBB63"),
    "ch3-2":  ("강구조 접합(I) - 볼트", "강구조",             "#5DBB63"),
    "ch3-3":  ("강구조 접합(II) - 용접","강구조",             "#5DBB63"),
    "ch3-4":  ("강구조 부재 설계",      "강구조",             "#5DBB63"),
    "ch4-1":  ("구조시스템",             "건축구조 일반사항",  "#9B59B6"),
    "ch4-2":  ("토질 및 기초",          "건축구조 일반사항",  "#9B59B6"),
    "ch4-3":  ("내진 설계",             "건축구조 일반사항",  "#9B59B6"),
}

# 해설 블록 패턴 - OCR 변형 포함
HAESUL_PAT = re.compile(r"[해하][절젤설]")

ANSWER_NUM_PAT = re.compile(r"(\d+)\.")


def parse_answer_line(blocks, ph):
    """
    해답 줄에서 문제 번호 목록 반환.
    OCR 변형 수정: 텍스트 순서가 내림차순이면 직전 번호+1로 교정.
    예) '5. ④ 6. ④ 1. ③ 8. ③' → [5,6,7,8]  (1→7 OCR 오인 수정)
    """
    for b in sorted(blocks, key=lambda x: -x[1]):
        if b[1] < ph * 0.60:
            break
        text = b[4]
        if "해답" in text or "정답" in text:
            nums_in_order = [int(m.group(1)) for m in ANSWER_NUM_PAT.finditer(text)]
            if len(nums_in_order) < 2:
                continue
            # 순서가 줄어드는 위치는 OCR 오인 → 직전+1로 교정
            fixed = []
            for n in nums_in_order:
                if fixed and n < fixed[-1]:
                    fixed.append(fixed[-1] + 1)
                else:
                    fixed.append(n)
            return sorted(set(fixed))
    return []


def match_num_validated(text, expected_nums):
    """
    expected_nums가 주어졌을 때 넓은 패턴으로 문제 번호 탐지.
    OCR 변형 포함: "2 그림", "1-", "Z " → 7, "『." → 1
    """
    t = text.strip()
    # 표준 마침표: "7. "
    m = re.match(r"^(\d{1,2})[\.．]\s", t)
    if m:
        n = int(m.group(1))
        if n in expected_nums:
            return n
    # 하이픈: "1- "
    m = re.match(r"^(\d{1,2})-\s", t)
    if m:
        n = int(m.group(1))
        if n in expected_nums:
            return n
    # 마침표 없이 한글: "2 그림", "3 다음", "1 (단,"
    m = re.match(r"^(\d{1,2})\s+[가-힣\(（]", t)
    if m:
        n = int(m.group(1))
        if n in expected_nums:
            return n
    # OCR: "Z " → 7
    if 7 in expected_nums and re.match(r"^Z\s+[가-힣\(（]", t):
        return 7
    # OCR: "『." or "「." → 1
    if 1 in expected_nums and re.match(r"^[『「1l][\.－\-]\s", t):
        return 1
    return None


def match_num_fallback(text):
    """
    해답 줄 없을 때 탐지. 마침표/하이픈 + 한글+공백 모두 허용.
    false-positive 방지를 위해 범위(1-50)만 제한.
    """
    t = text.strip()
    m = re.match(r"^(\d{1,2})[\.]\s", t)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 50:
            return n
    m = re.match(r"^(\d{1,2})-\s", t)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 50:
            return n
    # 마침표 없이 한글: "2 그림", "3 다음"
    m = re.match(r"^(\d{1,2})\s+[가-힣\(（]", t)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 50:
            return n
    # "『." → 1
    if re.match(r"^[『「][\.]\s", t):
        return 1
    # "l." → 1
    if re.match(r"^l[\.\-]\s", t):
        return 1
    return None


def first_haesul_y(body, y_start, y_end, cx0, cx1):
    """컬럼·y 범위에서 첫 해설 블록의 y0. 없으면 y_end."""
    PAD_X = 50
    for b in sorted(body, key=lambda x: x[1]):
        x0, y0, _, _, text = b[:5]
        if not (cx0 - PAD_X <= x0 <= cx1 + PAD_X):
            continue
        if y0 <= y_start + 8:
            continue
        if y0 >= y_end:
            break
        if HAESUL_PAT.search(text.strip()):
            return y0
    return y_end


def get_starts_in_col(body, col_x0, col_x1, expected_nums):
    """컬럼 내 문제 시작 블록 탐색. validated / fallback 자동 선택.
    내측 경계(col_x1)는 strict - 반대 컬럼 블록 혼입 방지."""
    OUTER_PAD = 30  # 외측 경계에만 여백
    use_validated = bool(expected_nums)
    found = {}
    for b in body:
        x0, y0 = b[0], b[1]
        if not (col_x0 - OUTER_PAD <= x0 < col_x1):
            continue
        if use_validated:
            n = match_num_validated(b[4], expected_nums)
        else:
            n = match_num_fallback(b[4])
        if n is not None and n not in found:
            found[n] = y0
    return sorted(found.items(), key=lambda kv: kv[1])  # [(num, y0), ...]


def fill_missing_by_interp(starts, expected_in_col, answer_y):
    """누락된 expected 번호를 이웃 y 평균으로 보간."""
    if not starts:
        return starts
    found_map = dict(starts)
    missing = [n for n in expected_in_col if n not in found_map]
    if not missing:
        return starts
    found_map[None] = answer_y  # sentinel
    for miss_num in missing:
        prev_y = next_y = None
        for n in sorted(expected_in_col):
            if n < miss_num and n in found_map:
                prev_y = found_map[n]
        for n in sorted(expected_in_col):
            if n > miss_num and n in found_map:
                next_y = found_map[n]
                break
        if next_y is None:
            next_y = answer_y
        est = (prev_y + next_y) / 2 if prev_y is not None else next_y / 2
        found_map[miss_num] = est
    del found_map[None]
    return sorted(found_map.items(), key=lambda kv: kv[1])


def make_crops(starts, cx0, cx1, pw, body, answer_y, ph):
    """문제 시작 목록 → 크롭 bbox 목록."""
    PAD = 6
    MIN_H = 30
    MIN_W = 60
    crops = []
    for i, (num, sy0) in enumerate(starts):
        next_y = starts[i + 1][1] if i + 1 < len(starts) else answer_y
        haesul_y = first_haesul_y(body, sy0, next_y, cx0, cx1)
        by0 = max(0, sy0 - PAD)
        by1 = min(ph, haesul_y)
        bx0 = round(max(0,  cx0 - PAD))
        bx1 = round(min(pw, cx1 + PAD))
        if by1 - by0 < MIN_H or bx1 - bx0 < MIN_W:
            continue
        crops.append({"num": num, "bbox": [bx0, round(by0), bx1, round(by1)]})
    return crops


def extract_page_crops(doc, page_1idx):
    page   = doc[page_1idx - 1]
    pw     = page.rect.width
    ph     = page.rect.height
    blocks = [b for b in page.get_text("blocks") if b[6] == 0]

    # 해답 줄 → expected problem 번호 (없으면 빈 set = fallback 모드)
    expected_nums = set(parse_answer_line(blocks, ph))

    # 헤더 y
    header_y = 0
    for b in sorted(blocks, key=lambda x: x[1]):
        if "핵심문제" in b[4]:
            header_y = b[3]
            break

    # 해답 줄 y
    answer_y = ph - 30
    for b in blocks:
        if ("해답" in b[4] or "정답" in b[4]) and b[1] > ph * 0.60:
            answer_y = b[1]
            break

    body = [b for b in blocks if b[1] >= header_y - 5 and b[3] <= answer_y + 5]

    if not body:
        return []

    half = pw / 2

    # ── 레이아웃 판별 ───────────────────────────────────────
    # expected_nums가 있으면 validated, 없으면 fallback 기준으로 후보 수집
    def _find_candidates(exp):
        return [b for b in body
                if (match_num_validated(b[4], exp) if exp
                    else match_num_fallback(b[4])) is not None]

    cands = _find_candidates(expected_nums)
    left_cands  = [b for b in cands if b[0] < half]
    right_cands = [b for b in cands if b[0] >= half]
    two_col = bool(left_cands) and bool(right_cands)

    if two_col:
        if expected_nums:
            sorted_exp = sorted(expected_nums)
            mid_idx   = len(sorted_exp) // 2
            left_exp  = set(sorted_exp[:mid_idx])
            right_exp = set(sorted_exp[mid_idx:])
        else:
            left_exp = right_exp = set()  # fallback: no split

        left_starts  = get_starts_in_col(body, 0,    half, left_exp)
        right_starts = get_starts_in_col(body, half, pw,   right_exp)

        if expected_nums:
            left_starts  = fill_missing_by_interp(left_starts,  sorted(left_exp),  answer_y)
            right_starts = fill_missing_by_interp(right_starts, sorted(right_exp), answer_y)

        left_crops  = make_crops(left_starts,  0,    half, pw, body, answer_y, ph)
        right_crops = make_crops(right_starts, half, pw,   pw, body, answer_y, ph)
        return left_crops + right_crops

    else:
        # 1컬럼
        starts = get_starts_in_col(body, 0, pw, expected_nums)
        if expected_nums:
            starts = fill_missing_by_interp(starts, sorted(expected_nums), answer_y)
        return make_crops(starts, 0, pw, pw, body, answer_y, ph)


def main():
    with open(PAGES_JSON, encoding="utf-8") as f:
        problem_pages = json.load(f)

    doc = fitz.open(str(PDF_PATH))
    all_crops = []
    seen_keys = set()

    for ch_id, pages in problem_pages.items():
        meta = CHAPTER_META.get(ch_id, ("", "", "#888"))
        ch_title, part_title, part_color = meta

        for page_num in pages:
            crops = extract_page_crops(doc, page_num)
            for c in crops:
                key = f"{ch_id}_{c['num']}"
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                all_crops.append({
                    "id":           key,
                    "chapterId":    ch_id,
                    "chapterTitle": ch_title,
                    "partTitle":    part_title,
                    "partColor":    part_color,
                    "num":          c["num"],
                    "page":         page_num,
                    "bbox":         c["bbox"],
                })

    doc.close()

    all_crops.sort(key=lambda x: (x["chapterId"], x["num"]))
    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(all_crops, f, ensure_ascii=False, indent=2)

    print(f"총 {len(all_crops)}개 문제 크롭 저장 → {OUTPUT}")

    # 검증 리포트
    from collections import defaultdict
    ch_counts = defaultdict(list)
    for c in all_crops:
        ch_counts[c["chapterId"]].append(c["num"])

    print("\n=== 챕터별 문제 수 ===")
    for ch_id in sorted(ch_counts.keys()):
        nums = sorted(ch_counts[ch_id])
        expected_max = max(nums)
        missing = [n for n in range(1, expected_max + 1) if n not in nums]
        status = "OK" if not missing else f"missing={missing[:8]}"
        print(f"  {ch_id}: {len(nums)}문제, max={expected_max} → {status}")


if __name__ == "__main__":
    main()
