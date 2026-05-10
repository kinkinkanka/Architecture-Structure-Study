"""Pre-generate all PDF pages as WebP images into static/pages/."""
import sys, os, io, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

try:
    import pymupdf
except ImportError:
    import fitz as pymupdf

from PIL import Image

SCALE = 2.5
QUALITY = 85
PDF_PATH = Path(__file__).parent.parent / "건축기사 구조_ocr.pdf"
OUT_DIR = Path(__file__).parent.parent / "static" / "pages"

def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open(str(PDF_PATH))
    total = doc.page_count
    print(f"PDF: {PDF_PATH.name}  ({total} pages)")

    mat = pymupdf.Matrix(SCALE, SCALE)
    t0 = time.time()
    done = 0

    for i in range(total):
        pnum = i + 1
        out_path = OUT_DIR / f"page_{pnum}.webp"
        if out_path.exists():
            done += 1
            continue

        page = doc[i]
        pix = page.get_pixmap(matrix=mat)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        buf = io.BytesIO()
        img.save(buf, format="WEBP", quality=QUALITY)
        out_path.write_bytes(buf.getvalue())

        done += 1
        elapsed = time.time() - t0
        eta = elapsed / done * (total - done)
        print(f"  {pnum}/{total}  {out_path.stat().st_size//1024}KB  ETA {eta:.0f}s", end="\r")

    print(f"\nDone. {done} pages in {time.time()-t0:.1f}s")
    total_mb = sum(f.stat().st_size for f in OUT_DIR.glob("*.webp")) / 1e6
    print(f"Total size: {total_mb:.1f} MB")

if __name__ == "__main__":
    main()
