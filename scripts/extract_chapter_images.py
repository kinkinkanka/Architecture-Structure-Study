"""
PDF에서 챕터별 이미지를 추출하여 static/data/images/{chapter_id}/ 에 저장.

사용법:
  python scripts/extract_chapter_images.py          # 전체 추출
  python scripts/extract_chapter_images.py ch1-1    # 특정 챕터만
"""
import sys
import json
from pathlib import Path
import fitz

sys.stdout.reconfigure(encoding="utf-8")

PDF_PATH  = Path(r"g:\내 드라이브\Main\2026\건축기사\실기\구조\건축기사 구조_ocr.pdf")
BASE_DIR  = Path(__file__).parent.parent
DATA_DIR  = BASE_DIR / "static" / "data"
IMAGES_DIR = DATA_DIR / "images"

MIN_BYTES = 8_000   # 8KB 미만은 장식용 소형 이미지로 간주, 스킵
MIN_DIM   = 80      # 가로 또는 세로 80px 미만 스킵


def extract_chapter_images(doc, ch, chapters, idx, out_dir: Path) -> int:
    start = ch.get("pdfStartPage", 0)
    end   = start + 22
    if idx + 1 < len(chapters):
        end = min(chapters[idx + 1].get("pdfStartPage", start + 22), start + 28)
    end = min(end, doc.page_count)

    seen_xrefs = set()
    saved = 0
    for page_num in range(start, end):
        page = doc[page_num]
        for img_info in page.get_images(full=True):
            xref = img_info[0]
            if xref in seen_xrefs:
                continue
            seen_xrefs.add(xref)

            base = doc.extract_image(xref)
            img_bytes = base["image"]
            w, h      = base.get("width", 0), base.get("height", 0)

            if len(img_bytes) < MIN_BYTES:
                continue
            if w < MIN_DIM and h < MIN_DIM:
                continue

            # 모든 이미지를 PNG로 변환 (브라우저 호환성)
            try:
                pix = fitz.Pixmap(doc, xref)
                if pix.n >= 5:           # CMYK → RGB 변환
                    pix = fitz.Pixmap(fitz.csRGB, pix)
                fname = out_dir / f"p{page_num+1:03d}_{saved+1:02d}.png"
                pix.save(str(fname))
                saved += 1
            except Exception:
                pass

    return saved


def main():
    with open(DATA_DIR / "chapters.json", encoding="utf-8") as f:
        data = json.load(f)
    chapters = data["chapters"]
    target_ids = set(sys.argv[1:])

    doc = fitz.open(str(PDF_PATH))
    total_saved = 0

    print(f"\n{'='*54}")
    print(f"  이미지 추출 시작 — 총 {len(chapters)}개 챕터")
    print(f"{'='*54}\n")

    for idx, ch in enumerate(chapters):
        if target_ids and ch["id"] not in target_ids:
            continue

        out_dir = IMAGES_DIR / ch["id"]
        if out_dir.exists() and list(out_dir.iterdir()) and ch["id"] not in target_ids:
            print(f"  ✓ [{ch['id']}] 이미 추출됨, 건너뜀")
            continue

        out_dir.mkdir(parents=True, exist_ok=True)
        n = extract_chapter_images(doc, ch, chapters, idx, out_dir)
        total_saved += n
        print(f"  {'📷' if n else ' -'} [{ch['id']:8s}] {ch['title'][:28]}: {n}개")

    doc.close()

    print(f"\n{'='*54}")
    print(f"  완료: 총 {total_saved}개 이미지 추출")
    print(f"  저장 위치: {IMAGES_DIR}")
    print(f"{'='*54}\n")


if __name__ == "__main__":
    main()
