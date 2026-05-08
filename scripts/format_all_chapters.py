"""
모든 챕터의 OCR 텍스트를 OpenAI GPT-4o-mini로 포맷하여 캐시 파일로 저장.
한 번만 실행하면 이후 웹사이트에서 API 없이 바로 볼 수 있습니다.

사용법:
  1. .env 파일에 OPENAI_API_KEY 설정
  2. python scripts/format_all_chapters.py
     (특정 챕터만: python scripts/format_all_chapters.py ch1-1 ch1-2)
"""
import sys
import os
import json
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

import fitz
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

PDF_PATH     = Path(r"g:\내 드라이브\Main\2026\건축기사\실기\구조\건축기사 구조_ocr.pdf")
BASE_DIR     = Path(__file__).parent.parent
DATA_DIR     = BASE_DIR / "static" / "data"
FORMATTED_DIR = DATA_DIR / "formatted"

PROMPT_SYSTEM = "당신은 건축구조 전문 교육자입니다. 한국어로 답변합니다."

PROMPT_USER = """건축기사 구조 교재의 **'{title}'** 챕터 OCR 텍스트를 **액티비티 다이어그램 흐름**으로 재정리해주세요.
핵심 출제 항목: {check}
핵심 키워드: {keywords}

## 페이지 구성 규칙 (순서 엄수)

각 학습 단계를 아래 이모지 접두어 ##헤더로 구분하고, 순서대로 배치하세요:

- `## 📖 개념명`: 핵심 개념 정의 (1~3문장)
- `## 📐 핵심 공식`: 수식을 LaTeX로 명확히 표현, 각 기호 설명 포함
- `## 💡 이해 포인트`: 직관적 이해, 물리적 의미, 주의사항
- `## ✏️ 예제 N`: 단계별 풀이를 **번호 목록(1. 2. 3.)**으로 표현
- `## ⚠️ 핵심 암기`: 시험 출제 포인트를 불릿 목록으로

## 다이어그램 (해당하는 경우 반드시 포함)

개념 간 관계, 계산 흐름, 판단 분기가 있으면 ```mermaid 블록으로 표현:
```mermaid
flowchart TD
    A[하중 계산] --> B{{인장지배?}}
    B -- Yes --> C[φ = 0.85]
    B -- No --> D[φ = 0.65]
```
- `flowchart TD` 사용, 한국어 레이블 허용
- 판단 분기는 `{{}}`, 일반 단계는 `[]`, 결과는 `(())`

## 작성 규칙
1. 수식은 **반드시** LaTeX ($...$, $$...$$) 형식으로 변환 (예: $$R = \\sqrt{{P_1^2 + P_2^2}}$$)
2. OCR로 깨진 수식·문자는 건축구조 전문 지식으로 복원
3. ■ 핵심문제 섹션 이후 내용은 생략
4. 총 2200자 내외 (다이어그램·수식 제외)
5. 표가 있으면 마크다운 표로 변환

OCR 텍스트:
{text}"""


def extract_chapter_text(doc, ch, chapters, idx):
    start = ch.get("pdfStartPage", 0)
    end   = start + 22
    if idx + 1 < len(chapters):
        end = min(chapters[idx + 1].get("pdfStartPage", start + 22), start + 28)
    end = min(end, doc.page_count)

    parts = []
    for i in range(start, end):
        t = doc[i].get_text()
        if t.strip():
            parts.append(t)
    return "\n\n".join(parts)[:6000]


def format_chapter(client, ch, raw_text):
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        max_tokens=2800,
        messages=[
            {"role": "system", "content": PROMPT_SYSTEM},
            {"role": "user", "content": PROMPT_USER.format(
                title    = ch["title"],
                check    = ", ".join(ch.get("check", [])),
                keywords = ", ".join(ch.get("keywords", [])),
                text     = raw_text,
            )},
        ],
    )
    return response.choices[0].message.content


def main():
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key or api_key == "YOUR_OPENAI_API_KEY":
        print("❌ OPENAI_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.")
        sys.exit(1)

    client = OpenAI(api_key=api_key)
    FORMATTED_DIR.mkdir(parents=True, exist_ok=True)

    with open(DATA_DIR / "chapters.json", encoding="utf-8") as f:
        data = json.load(f)
    chapters = data["chapters"]

    # 특정 챕터만 처리할 경우 인수로 받기
    target_ids = set(sys.argv[1:])

    doc = fitz.open(str(PDF_PATH))
    total   = len(chapters)
    success = 0
    skipped = 0

    print(f"\n{'='*54}")
    print(f"  챕터 포맷 시작 — 총 {total}개 챕터")
    print(f"{'='*54}\n")

    for idx, ch in enumerate(chapters):
        if target_ids and ch["id"] not in target_ids:
            continue

        cache_file = FORMATTED_DIR / f"{ch['id']}.md"
        prefix = f"[{idx+1:02d}/{total}] {ch['title']}"

        if cache_file.exists() and ch["id"] not in target_ids:
            print(f"  ✓ {prefix} — 캐시 있음, 건너뜀")
            skipped += 1
            continue

        print(f"  ⏳ {prefix} 처리 중...", end=" ", flush=True)
        try:
            raw_text  = extract_chapter_text(doc, ch, chapters, idx)
            formatted = format_chapter(client, ch, raw_text)
            cache_file.write_text(formatted, encoding="utf-8")
            print(f"완료 ({len(formatted):,}자)")
            success += 1
            time.sleep(0.3)  # Rate limit 방지
        except Exception as e:
            print(f"\n  ❌ 오류: {e}")

    doc.close()

    print(f"\n{'='*54}")
    print(f"  완료: {success}개 생성 / {skipped}개 건너뜀")
    print(f"  저장 위치: {FORMATTED_DIR}")
    print(f"{'='*54}\n")


if __name__ == "__main__":
    main()
