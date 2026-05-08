"""
GPT-4o Vision으로 PDF 각 페이지를 이미지화 → 4지선다 문제 추출 → problems.json 저장
실행: python scripts/extract_problems_vision.py
필요: pip install openai pymupdf python-dotenv
"""
import sys, json, base64, time, re
sys.stdout.reconfigure(encoding="utf-8")

from pathlib import Path
import fitz
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

PDF_PATH    = Path(r"g:\내 드라이브\Main\2026\건축기사\실기\구조\건축기사 구조_ocr.pdf")
OUTPUT_PATH = Path(__file__).parent.parent / "static" / "data" / "problems.json"

client = OpenAI()

# ── 챕터 범위 (0-indexed 페이지) ─────────────────────────────
CHAPTERS = [
    {"id":"ch1-1",  "title":"힘의 합성과 회전",    "part":"구조역학",          "color":"#4A90D9", "start":11, "end":21},
    {"id":"ch1-2",  "title":"힘의 평형",            "part":"구조역학",          "color":"#4A90D9", "start":21, "end":31},
    {"id":"ch1-3",  "title":"지점반력",              "part":"구조역학",          "color":"#4A90D9", "start":31, "end":43},
    {"id":"ch1-4",  "title":"전단력·휨모멘트",      "part":"구조역학",          "color":"#4A90D9", "start":43, "end":73},
    {"id":"ch1-5",  "title":"트러스 구조해석",      "part":"구조역학",          "color":"#4A90D9", "start":73, "end":87},
    {"id":"ch1-6",  "title":"단면의 성질",          "part":"구조역학",          "color":"#4A90D9", "start":87, "end":105},
    {"id":"ch1-7",  "title":"응력과 변형률",        "part":"구조역학",          "color":"#4A90D9", "start":105,"end":128},
    {"id":"ch1-8",  "title":"보의 휨변형",          "part":"구조역학",          "color":"#4A90D9", "start":128,"end":147},
    {"id":"ch1-9",  "title":"기둥",                  "part":"구조역학",          "color":"#4A90D9", "start":147,"end":165},
    {"id":"ch1-10", "title":"부정정구조",            "part":"구조역학",          "color":"#4A90D9", "start":165,"end":185},
    {"id":"ch2-1",  "title":"RC 해석과 설계의 원칙","part":"철근콘크리트구조",  "color":"#E8644A", "start":187,"end":210},
    {"id":"ch2-2",  "title":"RC구조해석 일반사항",  "part":"철근콘크리트구조",  "color":"#E8644A", "start":201,"end":237},
    {"id":"ch2-3",  "title":"RC 단철근 보 해석",    "part":"철근콘크리트구조",  "color":"#E8644A", "start":215,"end":257},
    {"id":"ch2-4",  "title":"RC 전단설계",          "part":"철근콘크리트구조",  "color":"#E8644A", "start":237,"end":269},
    {"id":"ch2-5",  "title":"RC 슬래브",            "part":"철근콘크리트구조",  "color":"#E8644A", "start":249,"end":281},
    {"id":"ch2-6",  "title":"RC구조 사용성",        "part":"철근콘크리트구조",  "color":"#E8644A", "start":263,"end":287},
    {"id":"ch2-7",  "title":"RC구조 철근 상세",     "part":"철근콘크리트구조",  "color":"#E8644A", "start":275,"end":293},
    {"id":"ch3-1",  "title":"강구조 일반사항",      "part":"강구조",            "color":"#5DBB63", "start":291,"end":307},
    {"id":"ch3-2",  "title":"강구조 접합(I) - 볼트","part":"강구조",            "color":"#5DBB63", "start":301,"end":323},
    {"id":"ch3-3",  "title":"강구조 접합(II) - 용접","part":"강구조",           "color":"#5DBB63", "start":309,"end":341},
    {"id":"ch3-4",  "title":"강구조 부재 설계",     "part":"강구조",            "color":"#5DBB63", "start":327,"end":345},
    {"id":"ch4-1",  "title":"구조시스템",            "part":"건축구조 일반사항", "color":"#9B59B6", "start":345,"end":365},
    {"id":"ch4-2",  "title":"토질 및 기초",         "part":"건축구조 일반사항", "color":"#9B59B6", "start":357,"end":381},
    {"id":"ch4-3",  "title":"내진 설계",            "part":"건축구조 일반사항", "color":"#9B59B6", "start":371,"end":393},
]

PROMPT = """이 페이지는 건축기사 구조 시험 교재입니다.
이 페이지에 있는 4지선다형 객관식 문제를 모두 찾아서 추출하세요.

규칙:
- 문제 본문에 수식이 있으면 LaTeX 표기(예: $F=ma$)로 변환
- 그림/도면이 필요한 선택지는 "[그림]"으로 표시
- 정답 표시가 있으면 answer_num에 1~4 숫자로 기재, 없으면 null
- 문제가 없는 페이지면 빈 배열 [] 반환

아래 JSON 형식으로만 반환 (마크다운 코드블록 없이):
[
  {
    "num": 문제번호(정수),
    "question": "문제 지문 전체",
    "options": ["선택지1", "선택지2", "선택지3", "선택지4"],
    "answer_num": null
  }
]"""


def page_to_b64(page, dpi=120):
    pix = page.get_pixmap(matrix=fitz.Matrix(dpi/72, dpi/72))
    return base64.b64encode(pix.tobytes("png")).decode()


def extract_from_page(page):
    b64 = page_to_b64(page)
    for attempt in range(3):
        try:
            resp = client.chat.completions.create(
                model="gpt-4o",
                max_tokens=2000,
                messages=[{"role":"user","content":[
                    {"type":"image_url","image_url":{"url":f"data:image/png;base64,{b64}"}},
                    {"type":"text","text":PROMPT}
                ]}]
            )
            text = resp.choices[0].message.content.strip()
            # strip markdown fences if present
            text = re.sub(r"^```[a-z]*\n?", "", text)
            text = re.sub(r"\n?```$", "", text)
            return json.loads(text)
        except json.JSONDecodeError as e:
            print(f"    JSON 파싱 실패 (시도 {attempt+1}): {e}")
            time.sleep(2)
        except Exception as e:
            print(f"    API 오류 (시도 {attempt+1}): {e}")
            time.sleep(5)
    return []


def main():
    if not PDF_PATH.exists():
        print(f"PDF 없음: {PDF_PATH}")
        return

    doc = fitz.open(str(PDF_PATH))
    print(f"PDF 로드: {doc.page_count}페이지\n")

    all_problems = []
    seen_nums = {}  # chapterId → set of problem nums (중복 방지)

    for ch in CHAPTERS:
        print(f"[{ch['id']}] {ch['title']} (p{ch['start']+1}~{ch['end']})")
        seen_nums[ch["id"]] = set()
        ch_problems = []

        for page_idx in range(ch["start"], min(ch["end"], doc.page_count)):
            print(f"  페이지 {page_idx+1} 처리 중...", end=" ", flush=True)
            probs = extract_from_page(doc[page_idx])

            added = 0
            for p in probs:
                num = p.get("num")
                if num in seen_nums[ch["id"]]:
                    continue
                seen_nums[ch["id"]].add(num)
                ch_problems.append({
                    "num":          num,
                    "question":     p.get("question","").strip(),
                    "options":      p.get("options", []),
                    "answer_num":   p.get("answer_num"),
                    "chapterId":    ch["id"],
                    "chapterTitle": ch["title"],
                    "partTitle":    ch["part"],
                    "partColor":    ch["color"],
                })
                added += 1

            print(f"{added}문제")
            time.sleep(0.5)  # rate limit 여유

        ch_problems.sort(key=lambda x: x["num"] or 0)
        all_problems.extend(ch_problems)
        print(f"  → 소계 {len(ch_problems)}문제\n")

    doc.close()

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump({"problems": all_problems, "total": len(all_problems)}, f, ensure_ascii=False, indent=2)

    print(f"완료: {len(all_problems)}문제 → {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
