"""
핵심문제 페이지에서 문제별 크롭 좌표 추출 → problem_crops.json
실행: python scripts/extract_crops.py
"""
import fitz, json, re, sys
sys.stdout.reconfigure(encoding="utf-8")
from pathlib import Path

PDF_PATH    = Path(r"g:\내 드라이브\Main\2026\건축기사\실기\구조\건축기사 구조_ocr.pdf")
PAGES_JSON  = Path(__file__).parent.parent / "static" / "data" / "problem_pages.json"
OUTPUT      = Path(__file__).parent.parent / "static" / "data" / "problem_crops.json"

CHAPTER_META = {
    "ch1-1":  ("힘의 합성과 회전",    "구조역학",          "#4A90D9"),
    "ch1-2":  ("힘의 평형",            "구조역학",          "#4A90D9"),
    "ch1-3":  ("지점반력",              "구조역학",          "#4A90D9"),
    "ch1-4":  ("전단력·휨모멘트",      "구조역학",          "#4A90D9"),
    "ch1-5":  ("트러스 구조해석",      "구조역학",          "#4A90D9"),
    "ch1-6":  ("단면의 성질",          "구조역학",          "#4A90D9"),
    "ch1-7":  ("응력과 변형률",        "구조역학",          "#4A90D9"),
    "ch1-8":  ("보의 휨변형",          "구조역학",          "#4A90D9"),
    "ch1-9":  ("기둥",                  "구조역학",          "#4A90D9"),
    "ch1-10": ("부정정구조",            "구조역학",          "#4A90D9"),
    "ch2-1":  ("RC 해석과 설계의 원칙","철근콘크리트구조",  "#E8644A"),
    "ch2-2":  ("RC구조해석 일반사항",  "철근콘크리트구조",  "#E8644A"),
    "ch2-3":  ("RC 단철근 보 해석",    "철근콘크리트구조",  "#E8644A"),
    "ch2-4":  ("RC 전단설계",          "철근콘크리트구조",  "#E8644A"),
    "ch2-5":  ("RC 슬래브",            "철근콘크리트구조",  "#E8644A"),
    "ch2-6":  ("RC구조 사용성",        "철근콘크리트구조",  "#E8644A"),
    "ch2-7":  ("RC구조 철근 상세",     "철근콘크리트구조",  "#E8644A"),
    "ch3-1":  ("강구조 일반사항",      "강구조",            "#5DBB63"),
    "ch3-2":  ("강구조 접합(I) - 볼트","강구조",            "#5DBB63"),
    "ch3-3":  ("강구조 접합(II) - 용접","강구조",           "#5DBB63"),
    "ch3-4":  ("강구조 부재 설계",     "강구조",            "#5DBB63"),
    "ch4-1":  ("구조시스템",            "건축구조 일반사항", "#9B59B6"),
    "ch4-2":  ("토질 및 기초",         "건축구조 일반사항", "#9B59B6"),
    "ch4-3":  ("내진 설계",            "건축구조 일반사항", "#9B59B6"),
}

NUM_PAT = re.compile(r"^(\d{1,2})\.\s")

def extract_page_crops(doc, page_1idx):
    page   = doc[page_1idx - 1]
    pw     = page.rect.width
    ph     = page.rect.height
    blocks = [b for b in page.get_text("blocks") if b[6] == 0]

    # 헤더(핵심문제 제목) 아래부터
    header_y = 0
    for b in sorted(blocks, key=lambda x: x[1]):
        if "핵심문제" in b[4]:
            header_y = b[3]
            break

    # 해답 줄 위까지만
    answer_y = ph - 30
    for b in blocks:
        if "해답" in b[4] and b[1] > ph * 0.65:
            answer_y = b[1]
            break

    body = [b for b in blocks if b[1] >= header_y - 5 and b[3] <= answer_y + 5]

    # 컬럼 midpoint: 문제 시작 블록들의 x0 분포로 자동 결정
    prob_x0s = [b[0] for b in body if NUM_PAT.match(b[4].strip())]
    if len(prob_x0s) >= 2:
        prob_x0s_sorted = sorted(prob_x0s)
        # 가장 큰 gap이 왼/오른쪽 경계
        gaps = [(prob_x0s_sorted[i+1] - prob_x0s_sorted[i], i)
                for i in range(len(prob_x0s_sorted)-1)]
        if gaps:
            max_gap_i = max(gaps)[1]
            mid = (prob_x0s_sorted[max_gap_i] + prob_x0s_sorted[max_gap_i+1]) / 2
        else:
            mid = pw / 2
    else:
        mid = pw / 2

    # 왼/오른 문제 시작 블록 (x0 기준으로 명확히 분리)
    def get_starts(min_x, max_x):
        starts = []
        for b in body:
            x0, y0 = b[0], b[1]
            if not (min_x <= x0 < max_x):
                continue
            m = NUM_PAT.match(b[4].strip())
            if m:
                starts.append((int(m.group(1)), y0))
        starts.sort(key=lambda s: s[1])
        return starts

    left_starts  = get_starts(0,   mid)
    right_starts = get_starts(mid, pw + 1)

    PAD = 8

    def make_crops(starts, cx0, cx1):
        crops = []
        for i, (num, sy0) in enumerate(starts):
            next_y = starts[i+1][1] if i+1 < len(starts) else answer_y
            by0 = max(0,  sy0 - PAD)
            by1 = min(ph, next_y + PAD)
            if by1 - by0 < 20:      # 너무 작은 크롭 무시
                continue
            crops.append({"num": num, "bbox": [
                round(max(0, cx0 - PAD)),
                round(by0),
                round(min(pw, cx1 + PAD)),
                round(by1)
            ]})
        return crops

    # 실제 크롭 x 범위는 페이지 절반 기준 (텍스트가 어디까지 퍼져있든 절반씩)
    half = pw / 2
    left_crops  = make_crops(left_starts,  0,    half)
    right_crops = make_crops(right_starts, half, pw)
    return left_crops + right_crops


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


if __name__ == "__main__":
    main()
