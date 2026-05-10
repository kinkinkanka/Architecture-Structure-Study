"""
건축구조 학습 웹사이트 - Flask 백엔드
OpenAI API 프록시 + 정적 파일 서빙 + 사용자 인증
"""
import os
import json
import sqlite3
import secrets
import base64
from pathlib import Path
from functools import wraps
import io
import fitz as pymupdf
from flask import Flask, render_template, request, jsonify, send_from_directory, Response, session, send_file
from werkzeug.security import generate_password_hash, check_password_hash
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

app = Flask(__name__)
app.config['JSON_AS_ASCII'] = False
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 604800  # 7 days for static files
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "static" / "data"
FORMATTED_DIR = DATA_DIR / "formatted"
DB_PATH = Path(os.environ.get("DB_PATH", str(BASE_DIR / "users.db")))

# PDF 경로: 환경변수 우선, 없으면 앱 폴더 내 파일 탐색
_pdf_env  = os.environ.get("PDF_PATH")
if _pdf_env:
    PDF_PATH = Path(_pdf_env)
else:
    _candidates = [
        BASE_DIR / "건축기사 구조_ocr.pdf",
        Path(r"g:\내 드라이브\Main\2026\건축기사\실기\구조\건축기사 구조_ocr.pdf"),
    ]
    PDF_PATH = next((p for p in _candidates if p.exists()), _candidates[0])

# PDF 문서 싱글톤 (요청마다 열지 않음)
_pdf_doc = None

def get_pdf_doc():
    global _pdf_doc
    if _pdf_doc is None and PDF_PATH.exists():
        _pdf_doc = pymupdf.open(str(PDF_PATH))
    return _pdf_doc

# ──── DB 초기화 ────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS user_data (
            user_id    INTEGER NOT NULL,
            data_key   TEXT    NOT NULL,
            data_json  TEXT    NOT NULL DEFAULT '{}',
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, data_key),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS explanations (
            problem_id  TEXT PRIMARY KEY,
            explanation TEXT NOT NULL,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS quiz_results (
            user_id         INTEGER NOT NULL,
            problem_id      TEXT    NOT NULL,
            selected_answer INTEGER NOT NULL,
            correct         INTEGER NOT NULL,
            attempts        INTEGER NOT NULL DEFAULT 1,
            last_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, problem_id)
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS migrations (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )""")
        # v2: clear old explanations that used [ ] math delimiters
        v = conn.execute("SELECT value FROM migrations WHERE key='explain_fmt'").fetchone()
        if not v or v["value"] != "2":
            conn.execute("DELETE FROM explanations")
            conn.execute("INSERT OR REPLACE INTO migrations (key, value) VALUES ('explain_fmt', '2')")

init_db()

# ──── 인증 데코레이터 ──────────────────────────────────────
def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session:
            return jsonify({"error": "로그인이 필요합니다"}), 401
        return f(*args, **kwargs)
    return decorated


def load_book_context():
    try:
        with open(DATA_DIR / "chapters.json", encoding="utf-8") as f:
            data = json.load(f)
        chapters = data.get("chapters", [])
        context = "## 건축기사 구조 교재 구성\n\n"
        current_part = ""
        for ch in chapters:
            if ch["partTitle"] != current_part:
                current_part = ch["partTitle"]
                context += f"\n### {current_part}\n"
            context += f"- **{ch['title']}**: {', '.join(ch['check'])}\n"
            context += f"  핵심 키워드: {', '.join(ch['keywords'])}\n"
        return context
    except Exception:
        return "건축기사 구조 교재 (구조역학, RC구조, 강구조, 건축구조 일반사항)"


BOOK_CONTEXT = load_book_context()

SYSTEM_PROMPT = f"""당신은 건축구조 전문 AI 튜터입니다. 건축기사 시험을 준비하는 수험생을 돕고 있습니다.

{BOOK_CONTEXT}

## 답변 가이드라인
1. 교재 내용과 관련된 질문에는 교재의 체계를 따라 명확하게 설명하세요.
2. 수식은 LaTeX 형식(`$...$` 또는 `$$...$$`)으로 표현하세요.
3. 교재 범위를 벗어난 질문도 건축구조 관점에서 친절히 답변하세요.
4. 계산 문제는 단계별로 풀이 과정을 보여주세요.
5. 한국어로 답변하세요.
6. 핵심 공식이나 암기사항은 **굵게** 강조하세요.
7. 답변 끝에 관련 챕터를 언급해주면 좋습니다.
"""


def get_openai_client():
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return None
    return OpenAI(api_key=api_key)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/sw.js")
def service_worker():
    resp = send_from_directory(str(BASE_DIR), "sw.js",
                               mimetype="application/javascript")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


@app.route("/pdf")
def serve_pdf():
    if PDF_PATH.exists():
        resp = send_from_directory(
            str(PDF_PATH.parent),
            PDF_PATH.name,
            mimetype="application/pdf"
        )
        resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp
    return jsonify({"error": "PDF not found"}), 404


@app.route("/api/chat", methods=["POST"])
def chat():
    """OpenAI 채팅 엔드포인트 (스트리밍)"""
    client = get_openai_client()
    if not client:
        return jsonify({"error": "OPENAI_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요."}), 500

    data = request.get_json()
    messages = data.get("messages", [])
    if not messages:
        return jsonify({"error": "메시지가 없습니다."}), 400

    formatted = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in messages:
        if m.get("role") in ("user", "assistant") and m.get("content"):
            formatted.append({"role": m["role"], "content": m["content"]})

    def generate():
        try:
            stream = client.chat.completions.create(
                model="gpt-4o-mini",
                max_tokens=2048,
                messages=formatted,
                stream=True,
            )
            for chunk in stream:
                delta = chunk.choices[0].delta
                if delta.content:
                    yield f"data: {json.dumps({'text': delta.content}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/api/chapters")
def get_chapters():
    try:
        with open(DATA_DIR / "chapters.json", encoding="utf-8") as f:
            return jsonify(json.load(f))
    except FileNotFoundError:
        return jsonify({"error": "chapters.json not found"}), 404


@app.route("/api/problems")
def get_problems():
    chapter_id = request.args.get("chapter")
    limit = int(request.args.get("limit", 50))
    try:
        with open(DATA_DIR / "problems.json", encoding="utf-8") as f:
            data = json.load(f)
        problems = data.get("problems", [])
        if chapter_id:
            problems = [p for p in problems if p.get("chapterId") == chapter_id]
        return jsonify({"problems": problems[:limit], "total": len(problems)})
    except FileNotFoundError:
        return jsonify({"error": "problems.json not found"}), 404


@app.route("/api/graph")
def get_graph():
    try:
        with open(DATA_DIR / "graph.json", encoding="utf-8") as f:
            return jsonify(json.load(f))
    except FileNotFoundError:
        return jsonify({"error": "graph.json not found"}), 404


@app.route("/api/problem-pages")
def get_problem_pages():
    try:
        with open(DATA_DIR / "problem_pages.json", encoding="utf-8") as f:
            return jsonify(json.load(f))
    except FileNotFoundError:
        return jsonify({}), 404


@app.route("/api/page-image/<int:page_num>")
def get_page_image(page_num):
    """PDF 페이지 WebP 반환 — pre-generated 파일 우선, 없으면 실시간 렌더."""
    pages_dir = BASE_DIR / "static" / "pages"
    static_file = pages_dir / f"page_{page_num}.webp"
    if static_file.exists():
        resp = send_from_directory(str(pages_dir), f"page_{page_num}.webp",
                                   mimetype="image/webp")
        resp.headers["Cache-Control"] = "public, max-age=604800, immutable"
        return resp

    # Fallback: render on-the-fly
    doc = get_pdf_doc()
    if not doc:
        return jsonify({"error": "PDF not found"}), 404
    try:
        if page_num < 1 or page_num > doc.page_count:
            return jsonify({"error": "page out of range"}), 400
        from PIL import Image
        page = doc[page_num - 1]
        pix  = page.get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5))
        img  = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        buf  = io.BytesIO()
        img.save(buf, format="WEBP", quality=80)
        buf.seek(0)
        resp = send_file(buf, mimetype="image/webp")
        resp.headers["Cache-Control"] = "public, max-age=604800, immutable"
        return resp
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/crop-image/<int:page_num>")
def get_crop_image(page_num):
    """PDF 페이지 특정 영역을 크롭한 PNG 반환
    Query: x0, y0, x1, y1 (PDF 좌표계 포인트)"""
    doc = get_pdf_doc()
    if not doc:
        return jsonify({"error": "PDF not found"}), 404
    try:
        x0 = float(request.args.get("x0", 0))
        y0 = float(request.args.get("y0", 0))
        x1 = float(request.args.get("x1", 0))
        y1 = float(request.args.get("y1", 0))
        SCALE = 2.0
        page = doc[page_num - 1]
        clip = pymupdf.Rect(x0, y0, x1, y1)
        pix  = page.get_pixmap(matrix=pymupdf.Matrix(SCALE, SCALE), clip=clip)
        img_bytes = pix.tobytes("png")
        resp = send_file(io.BytesIO(img_bytes), mimetype="image/png")
        resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/quiz-explain", methods=["POST"])
def quiz_explain():
    """문제 AI 해설 (DB 캐시 우선, 없으면 OpenAI Vision 생성)"""
    data       = request.get_json() or {}
    problem_id = data.get("problem_id", "")
    answer     = data.get("answer")      # 1-4 (correct answer)
    page       = data.get("page")
    bbox       = data.get("bbox")        # [x0,y0,x1,y1]

    if not problem_id:
        return jsonify({"error": "problem_id 필요"}), 400

    # 캐시 확인
    with get_db() as conn:
        row = conn.execute(
            "SELECT explanation FROM explanations WHERE problem_id=?", (problem_id,)
        ).fetchone()
    if row:
        return jsonify({"explanation": row["explanation"]})

    # OpenAI 생성
    client = get_openai_client()
    if not client:
        return jsonify({"error": "OPENAI_API_KEY가 설정되지 않았습니다."}), 503

    # PDF에서 직접 크롭 이미지 생성
    doc = get_pdf_doc()
    if not doc or not page or not bbox:
        return jsonify({"error": "PDF 또는 좌표 정보 없음"}), 503

    try:
        pg   = doc[int(page) - 1]
        clip = pymupdf.Rect(*bbox)
        pix  = pg.get_pixmap(matrix=pymupdf.Matrix(2.0, 2.0), clip=clip)
        img_b64 = base64.b64encode(pix.tobytes("png")).decode()
    except Exception as e:
        return jsonify({"error": f"이미지 생성 실패: {e}"}), 500

    labels = {1:"①", 2:"②", 3:"③", 4:"④"}
    answer_label = labels.get(answer, "?")
    math_rule = (
        "수식 규칙: 인라인 수식은 $수식$ 형태로, 별도 줄 수식은 $$수식$$ 형태로 작성하세요. "
        "대괄호 [ ] 나 \\[ \\] 는 수식 구분자로 절대 사용하지 마세요."
    )
    prompt = (
        f"건축기사 구조 시험 문제입니다. 정답은 {answer_label}번입니다. "
        f"왜 이것이 정답인지 단계별로 간결하게 설명해주세요. {math_rule} 한국어로 답하세요."
    ) if answer else (
        f"건축기사 구조 시험 문제입니다. 이 문제를 분석하고 풀이과정을 설명해주세요. "
        f"{math_rule} 한국어로 답하세요."
    )

    try:
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            max_tokens=900,
            messages=[{"role": "user", "content": [
                {"type": "image_url",
                 "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
                {"type": "text", "text": prompt},
            ]}]
        )
        explanation = resp.choices[0].message.content
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    # 캐시 저장
    with get_db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO explanations (problem_id, explanation) VALUES (?,?)",
            (problem_id, explanation)
        )
    return jsonify({"explanation": explanation})


@app.route("/api/quiz-result", methods=["POST"])
@login_required
def save_quiz_result():
    """퀴즈 결과 저장 (정답 여부, 선택 답, 횟수)"""
    data            = request.get_json() or {}
    problem_id      = data.get("problem_id", "")
    selected_answer = int(data.get("selected_answer", 0))
    correct         = int(bool(data.get("correct")))
    if not problem_id:
        return jsonify({"error": "problem_id 필요"}), 400
    with get_db() as conn:
        conn.execute(
            """INSERT INTO quiz_results (user_id,problem_id,selected_answer,correct,attempts,last_at)
               VALUES (?,?,?,?,1,CURRENT_TIMESTAMP)
               ON CONFLICT(user_id,problem_id) DO UPDATE SET
                 selected_answer=excluded.selected_answer,
                 correct=excluded.correct,
                 attempts=attempts+1,
                 last_at=excluded.last_at""",
            (session["user_id"], problem_id, selected_answer, correct)
        )
    return jsonify({"ok": True})


@app.route("/api/quiz-results")
@login_required
def get_quiz_results():
    """사용자의 전체 퀴즈 결과 반환"""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT problem_id,selected_answer,correct,attempts FROM quiz_results WHERE user_id=?",
            (session["user_id"],)
        ).fetchall()
    return jsonify({
        r["problem_id"]: {
            "selectedAnswer": r["selected_answer"],
            "correct": bool(r["correct"]),
            "attempts": r["attempts"],
        } for r in rows
    })


@app.route("/api/chapters", methods=["POST"])
def add_chapter():
    new_ch = request.get_json()
    required = ["id", "title", "partId", "startPage"]
    if not all(k in new_ch for k in required):
        return jsonify({"error": f"필수 필드 누락: {required}"}), 400

    with open(DATA_DIR / "chapters.json", encoding="utf-8") as f:
        data = json.load(f)

    if any(c["id"] == new_ch["id"] for c in data.get("chapters", [])):
        return jsonify({"error": "이미 존재하는 챕터 ID입니다."}), 409

    data["chapters"].append(new_ch)
    with open(DATA_DIR / "chapters.json", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    return jsonify({"success": True, "chapter": new_ch})


@app.route("/api/chapter-images/<chapter_id>")
def get_chapter_images(chapter_id):
    """챕터 추출 이미지 목록 반환"""
    img_dir = DATA_DIR / "images" / chapter_id
    if not img_dir.exists():
        return jsonify({"images": []})
    exts = {'.png', '.jpg', '.jpeg', '.gif', '.webp'}
    images = sorted(
        f"/static/data/images/{chapter_id}/{f.name}"
        for f in img_dir.iterdir()
        if f.suffix.lower() in exts
    )
    return jsonify({"images": images})


@app.route("/api/chapter-content/<chapter_id>")
def get_chapter_content(chapter_id):
    """캐시된 챕터 마크다운 파일 서빙 (캐시 없으면 404)"""
    try:
        cache_file = FORMATTED_DIR / f"{chapter_id}.md"
        if cache_file.exists():
            return jsonify({"content": cache_file.read_text(encoding="utf-8"), "cached": True})
        return jsonify({"error": "not_cached"}), 404
    except Exception as e:
        return jsonify({"error": f"서버 오류: {str(e)}"}), 500


@app.route("/api/chapter-content/<chapter_id>", methods=["DELETE"])
def delete_chapter_cache(chapter_id):
    cache_file = FORMATTED_DIR / f"{chapter_id}.md"
    if cache_file.exists():
        cache_file.unlink()
        return jsonify({"success": True})
    return jsonify({"success": False, "message": "캐시 없음"})


@app.route("/api/ask-vision", methods=["POST"])
def ask_vision():
    """이미지 영역 + 질문 → GPT-4o-mini Vision 답변"""
    client = get_openai_client()
    if not client:
        return jsonify({"error": "OPENAI_API_KEY가 설정되지 않았습니다."}), 503

    data     = request.get_json()
    image_b64 = data.get("image", "")   # base64 PNG (data URL 포함)
    question  = data.get("question", "").strip() or "이 내용을 설명해주세요."

    # data URL prefix 제거
    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]

    try:
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            max_tokens=1200,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image_url",
                     "image_url": {"url": f"data:image/png;base64,{image_b64}"}},
                    {"type": "text",
                     "text": f"건축기사 구조 교재의 내용입니다. {question}"}
                ]
            }]
        )
        return jsonify({"answer": resp.choices[0].message.content})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ──── 인증 API ────────────────────────────────────────────
@app.route("/api/me")
def api_me():
    if "user_id" not in session:
        return jsonify({"loggedIn": False})
    return jsonify({"loggedIn": True, "username": session["username"]})


@app.route("/api/register", methods=["POST"])
def api_register():
    data = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")

    if len(username) < 2:
        return jsonify({"error": "사용자명은 2자 이상이어야 합니다"}), 400
    if len(password) < 4:
        return jsonify({"error": "비밀번호는 4자 이상이어야 합니다"}), 400

    try:
        with get_db() as conn:
            conn.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                (username, generate_password_hash(password))
            )
            user_id = conn.execute(
                "SELECT id FROM users WHERE username=?", (username,)
            ).fetchone()["id"]
        session["user_id"] = user_id
        session["username"] = username
        return jsonify({"ok": True, "username": username})
    except sqlite3.IntegrityError:
        return jsonify({"error": "이미 사용 중인 사용자명입니다"}), 400


@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")

    with get_db() as conn:
        user = conn.execute(
            "SELECT * FROM users WHERE username=?", (username,)
        ).fetchone()

    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "사용자명 또는 비밀번호가 틀렸습니다"}), 401

    session["user_id"] = user["id"]
    session["username"] = user["username"]
    return jsonify({"ok": True, "username": user["username"]})


@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})


# ──── 사용자 데이터 API ───────────────────────────────────
ALLOWED_KEYS = {"ch_done", "ch_bookmarks", "scan_annotations", "scan_highlights"}

@app.route("/api/userdata/<key>")
@login_required
def get_userdata(key):
    if key not in ALLOWED_KEYS:
        return jsonify({"error": "invalid key"}), 400
    with get_db() as conn:
        row = conn.execute(
            "SELECT data_json FROM user_data WHERE user_id=? AND data_key=?",
            (session["user_id"], key)
        ).fetchone()
    return jsonify({"data": row["data_json"] if row else None})


@app.route("/api/userdata/<key>", methods=["POST"])
@login_required
def set_userdata(key):
    if key not in ALLOWED_KEYS:
        return jsonify({"error": "invalid key"}), 400
    data_json = request.get_json(force=True).get("data", "null")
    with get_db() as conn:
        conn.execute(
            """INSERT INTO user_data (user_id, data_key, data_json, updated_at)
               VALUES (?, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(user_id, data_key)
               DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at""",
            (session["user_id"], key, data_json)
        )
    return jsonify({"ok": True})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_ENV") != "production"
    print(f"건축구조 학습 웹사이트 시작 → http://localhost:{port}")
    app.run(debug=debug, host="0.0.0.0", port=port)
