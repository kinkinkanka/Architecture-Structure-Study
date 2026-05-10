/* ===================================================
   건축구조 학습 웹사이트 - 메인 앱 v2
   =================================================== */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";

// PDF는 항상 고정 스케일로 렌더링 → CSS zoom이 픽셀을 확대하는 게 아니라 이미 렌더된 해상도를 보여줌
const RENDER_SCALE = 3;

/* ===== 효과음 (Web Audio API) ===== */
const SFX = {
  _ctx: null,
  get ctx() {
    if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    return this._ctx;
  },
  play(type) {
    try {
      const ctx = this.ctx;
      if (ctx.state === "suspended") ctx.resume();
      const recipes = {
        click:    [{ f:600, d:.06, v:.05, t:"sine" }],
        nav:      [{ f:440, d:.10, v:.06, t:"sine" }],
        success:  [{ f:523, d:.12, v:.08, t:"sine" }, { f:659, d:.15, v:.08, t:"sine", delay:.12 }],
        wrong:    [{ f:220, d:.18, v:.06, t:"sawtooth" }],
        bookmark: [{ f:880, d:.10, v:.07, t:"sine" }],
        done:     [{ f:523, d:.10, v:.08, t:"sine" }, { f:659, d:.10, v:.08, t:"sine", delay:.10 }, { f:784, d:.20, v:.08, t:"sine", delay:.20 }],
        tab:      [{ f:350, d:.08, v:.04, t:"sine" }],
        open:     [{ f:500, d:.12, v:.05, t:"sine" }],
        flip:     [{ f:800, d:.04, v:.04, t:"sine" }, { f:400, d:.08, v:.03, t:"sine", delay:.04 }],
      };
      const notes = recipes[type] || recipes.click;
      notes.forEach(n => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = n.t || "sine";
        osc.frequency.value = n.f;
        const t = ctx.currentTime + (n.delay || 0);
        gain.gain.setValueAtTime(n.v, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + n.d);
        osc.start(t); osc.stop(t + n.d);
      });
    } catch (_) {}
  }
};

/* 모든 버튼에 클릭음 자동 적용 */
document.addEventListener("click", e => {
  const btn = e.target.closest("button, .chapter-item, .tab-btn, .quiz-option");
  if (btn) SFX.play("click");
});

/* 좌우 화살표 페이지 이동 */
document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (!State.currentChapter) return;
  if (e.key === "ArrowRight") { e.preventDefault(); SFX.play("flip"); showSpread(State.currentLeftPage + 2); }
  if (e.key === "ArrowLeft")  { e.preventDefault(); SFX.play("flip"); showSpread(State.currentLeftPage - 2); }
});

/* ===== 전역 상태 ===== */
const State = {
  chapters: [], parts: [], problems: [],
  currentChapter: null,
  loggedIn: false, currentUser: null,
  quizQueue: [], quizIndex: 0,
  chatHistory: [],
  quizHistory: {},
  graphData: null, selectedGraphNode: null,
  done:      new Set(JSON.parse(localStorage.getItem("ch_done")      || "[]")),
  bookmarks: new Set(JSON.parse(localStorage.getItem("ch_bookmarks") || "[]")),
  quizMode: "card",
  // 스캔 뷰어 (PDF.js 기반)
  pdfDoc: null,
  pdfTotalPages: 0,
  currentLeftPage: 1,
  chapterStartPage: 1,
  chapterEndPage: 1,
  zoomLevel: 1.0,
  // 페이지 렌더 캐시
  pageCache: new Map(),   // pageNum → offscreen HTMLCanvasElement
  textCache: new Map(),   // pageNum → [{x,y,w,h}] (canvas coords)
  currentScale: null,
  // 주석
  annotations: JSON.parse(localStorage.getItem("scan_annotations") || "{}"),
  annPanelChapter: null,
  // 형광펜
  highlights: JSON.parse(localStorage.getItem("scan_highlights") || "{}"),
  panX: 0, panY: 0,   // 뷰어 이동 (transform 기반)
  hlMode: false,
  panMode: false,
  _panStart: null,
  hlTool: "pen",          // "pen" | "eraser"
  hlColor: "yellow",
  hlSnap: true,           // 텍스트 스냅 모드
  hlFilter: new Set(["yellow","green","pink","blue"]),
  _hlLivePath: null,
  _hlLivePoints: [],      // 현재 드로잉 중인 canvas 좌표 (eraser용도 공유)
  // 드래그 (AI 질문)
  _drag: null, _pendingCrop: null, _pendingRect: null,
};

const HL_COLORS = {
  yellow: { hex: "#FFE600", label: "중요" },
  green:  { hex: "#00CC44", label: "공식" },
  pink:   { hex: "#FF5599", label: "암기" },
  blue:   { hex: "#3399FF", label: "정의" },
};

function saveProgress() {
  const doneData = JSON.stringify([...State.done]);
  const bkData   = JSON.stringify([...State.bookmarks]);
  localStorage.setItem("ch_done",      doneData);
  localStorage.setItem("ch_bookmarks", bkData);
  syncToServer("ch_done",      doneData);
  syncToServer("ch_bookmarks", bkData);
}
function saveAnnotations() {
  const d = JSON.stringify(State.annotations);
  localStorage.setItem("scan_annotations", d);
  syncToServer("scan_annotations", d);
}
function saveHighlights() {
  const d = JSON.stringify(State.highlights);
  localStorage.setItem("scan_highlights", d);
  syncToServer("scan_highlights", d);
}

/* 서버 동기화 (fire-and-forget) */
async function syncToServer(key, jsonStr) {
  if (!State.loggedIn) return;
  try {
    await fetch(`/api/userdata/${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: jsonStr }),
    });
  } catch (_) {}
}

/* 서버에서 사용자 데이터 로드 */
async function loadUserDataFromServer() {
  const keys = ["ch_done", "ch_bookmarks", "scan_annotations", "scan_highlights"];
  await Promise.all(keys.map(async key => {
    try {
      const res  = await fetch(`/api/userdata/${key}`);
      const { data } = await res.json();
      if (data !== null) {
        // 서버 데이터 우선 → localStorage + State 갱신
        localStorage.setItem(key, data);
        if (key === "ch_done")
          State.done      = new Set(JSON.parse(data || "[]"));
        else if (key === "ch_bookmarks")
          State.bookmarks = new Set(JSON.parse(data || "[]"));
        else if (key === "scan_annotations")
          State.annotations = JSON.parse(data || "{}");
        else if (key === "scan_highlights")
          State.highlights  = JSON.parse(data || "{}");
      } else {
        // 첫 로그인: 로컬 데이터를 서버에 업로드
        const local = localStorage.getItem(key);
        if (local) syncToServer(key, local);
      }
    } catch (_) {}
  }));
}

/* ===== 초기화 ===== */
document.addEventListener("DOMContentLoaded", async () => {
  setupAuthUI();

  // 인증 상태 확인
  const res  = await fetch("/api/me");
  const auth = await res.json();

  if (!auth.loggedIn) {
    document.getElementById("auth-screen").classList.remove("hidden");
    return;
  }

  await bootApp(auth.username);
});

async function bootApp(username) {
  State.loggedIn   = true;
  State.currentUser = username;

  // 서버 데이터 로드 후 앱 초기화
  await loadUserDataFromServer();

  // 헤더 유저 뱃지
  document.getElementById("user-name-badge").textContent = `👤 ${username}`;
  document.getElementById("auth-screen").classList.add("hidden");

  setupTabs();
  await loadData();
  renderSidebar();
  renderWelcomeStats();
  setupStudyControls();
  setupZoom();
  setupPan();
  setupResizePanels();
  setupScanNav();
  setupDragSelect();
  setupHighlighter();
  setupAnnotationModal();
  setupAnnDetail();
  await setupQuizTab();
  setupChatTab();
  setupGraphTab();
  setupModal();
}

/* ===== 인증 UI ===== */
function setupAuthUI() {
  // 탭 전환
  document.querySelectorAll(".auth-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.auth;
      document.querySelectorAll(".auth-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("auth-form-login").classList.toggle("hidden",    target !== "login");
      document.getElementById("auth-form-register").classList.toggle("hidden", target !== "register");
      document.getElementById("auth-error").textContent = "";
    });
  });

  // Enter 키
  ["auth-username","auth-password"].forEach(id => {
    document.getElementById(id).addEventListener("keydown", e => {
      if (e.key === "Enter") document.getElementById("btn-do-login").click();
    });
  });
  ["reg-username","reg-password","reg-password2"].forEach(id => {
    document.getElementById(id).addEventListener("keydown", e => {
      if (e.key === "Enter") document.getElementById("btn-do-register").click();
    });
  });

  document.getElementById("btn-do-login").addEventListener("click", async () => {
    const username = document.getElementById("auth-username").value.trim();
    const password = document.getElementById("auth-password").value;
    setAuthError("");
    const res  = await fetch("/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { setAuthError(data.error); return; }
    await bootApp(data.username);
  });

  document.getElementById("btn-do-register").addEventListener("click", async () => {
    const username  = document.getElementById("reg-username").value.trim();
    const password  = document.getElementById("reg-password").value;
    const password2 = document.getElementById("reg-password2").value;
    setAuthError("");
    if (password !== password2) { setAuthError("비밀번호가 일치하지 않습니다"); return; }
    const res  = await fetch("/api/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { setAuthError(data.error); return; }
    await bootApp(data.username);
  });

  document.getElementById("btn-logout").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    State.loggedIn  = false;
    State.currentUser = null;
    document.getElementById("auth-screen").classList.remove("hidden");
    document.getElementById("auth-username").value = "";
    document.getElementById("auth-password").value = "";
  });
}

function setAuthError(msg) {
  document.getElementById("auth-error").textContent = msg;
}

/* ===== 탭 ===== */
function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.add("hidden"));
      btn.classList.add("active");
      document.getElementById(`tab-${tab}`).classList.remove("hidden");
      SFX.play("tab");
      if (tab === "graph" && State.graphData) renderGraph();
    });
  });
}

/* ===== 데이터 로드 ===== */
async function loadData() {
  const [chRes, prRes, grRes] = await Promise.all([
    fetch("/api/chapters"), fetch("/api/problems?limit=2000"), fetch("/api/graph")
  ]);
  const chData = await chRes.json();
  const prData = await prRes.json();
  State.graphData = await grRes.json();
  State.chapters = chData.chapters || [];
  State.parts    = chData.parts    || [];
  State.problems = prData.problems || [];
}

/* ===== 사이드바 ===== */
function renderSidebar() {
  const list = document.getElementById("chapter-list");
  list.innerHTML = "";
  const grouped = {};
  State.chapters.forEach(ch => {
    if (!grouped[ch.partId]) grouped[ch.partId] = [];
    grouped[ch.partId].push(ch);
  });
  State.parts.forEach(part => {
    const chs = grouped[part.id] || [];
    const group = document.createElement("div");
    group.className = "part-group";
    const header = document.createElement("div");
    header.className = "part-header";
    header.innerHTML = `<span class="part-dot" style="background:${part.color}"></span><span>${part.title}</span><span class="part-arrow">▾</span>`;
    header.addEventListener("click", () => { group.classList.toggle("collapsed"); SFX.play("nav"); });
    const chaptersDiv = document.createElement("div");
    chaptersDiv.className = "part-chapters";
    chs.forEach(ch => chaptersDiv.appendChild(makeChapterItem(ch)));
    group.appendChild(header);
    group.appendChild(chaptersDiv);
    list.appendChild(group);
  });

  document.getElementById("chapter-search").addEventListener("input", e => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll(".chapter-item").forEach(el => {
      el.style.display = el.dataset.title.toLowerCase().includes(q) ? "" : "none";
    });
  });
}

function makeChapterItem(ch) {
  const div = document.createElement("div");
  div.className = "chapter-item";
  div.dataset.chId  = ch.id;
  div.dataset.title = ch.title;
  const isDone = State.done.has(ch.id);
  const isBm   = State.bookmarks.has(ch.id);
  div.innerHTML = `<span style="flex:1">${ch.title}</span>
    ${isBm   ? '<span class="chapter-bookmark-mark">★</span>' : ""}
    ${isDone ? '<span class="chapter-done-mark">✓</span>'     : ""}`;
  div.addEventListener("click", () => openChapter(ch));
  return div;
}

function refreshSidebarItem(chId) {
  const el = document.querySelector(`.chapter-item[data-ch-id="${chId}"]`);
  if (!el) return;
  const ch = State.chapters.find(c => c.id === chId);
  if (!ch) return;
  const isDone = State.done.has(chId), isBm = State.bookmarks.has(chId);
  el.innerHTML = `<span style="flex:1">${ch.title}</span>
    ${isBm   ? '<span class="chapter-bookmark-mark">★</span>' : ""}
    ${isDone ? '<span class="chapter-done-mark">✓</span>'     : ""}`;
}

/* ===== 챕터 열기 ===== */
function openChapter(ch) {
  State.currentChapter = ch;
  SFX.play("open");

  document.querySelectorAll(".chapter-item").forEach(el => {
    el.classList.remove("active"); el.style.borderLeft = "";
  });
  const el = document.querySelector(`.chapter-item[data-ch-id="${ch.id}"]`);
  if (el) { el.classList.add("active"); el.style.borderLeft = `3px solid ${ch.partColor}`; }

  document.getElementById("study-welcome").classList.add("hidden");
  document.getElementById("study-content").classList.remove("hidden");

  const badge = document.getElementById("content-part-badge");
  badge.textContent = ch.partTitle; badge.style.background = ch.partColor;
  document.getElementById("content-title").textContent = ch.title;

  document.getElementById("check-box").innerHTML = `
    <div class="check-box-title">CHECK</div>
    <div class="check-tags">${(ch.check||[]).map(c=>`<span class="check-tag">${c}</span>`).join("")}</div>`;

  const btnBm = document.getElementById("btn-bookmark");
  const btnDone = document.getElementById("btn-mark-done");
  btnBm.textContent  = State.bookmarks.has(ch.id) ? "★ 북마크 해제" : "☆ 북마크";
  btnBm.classList.toggle("active", State.bookmarks.has(ch.id));
  btnDone.textContent = State.done.has(ch.id) ? "✓ 완료됨" : "✓ 학습 완료";
  btnDone.classList.toggle("active", State.done.has(ch.id));

  loadChapterScan(ch);
}

/* ===== 학습 컨트롤 설정 ===== */
function setupStudyControls() {
  document.getElementById("btn-bookmark").addEventListener("click", () => {
    const ch = State.currentChapter; if (!ch) return;
    if (State.bookmarks.has(ch.id)) State.bookmarks.delete(ch.id);
    else { State.bookmarks.add(ch.id); SFX.play("bookmark"); }
    saveProgress(); refreshSidebarItem(ch.id);
    const btn = document.getElementById("btn-bookmark");
    btn.textContent = State.bookmarks.has(ch.id) ? "★ 북마크 해제" : "☆ 북마크";
    btn.classList.toggle("active", State.bookmarks.has(ch.id));
  });

  document.getElementById("btn-mark-done").addEventListener("click", () => {
    const ch = State.currentChapter; if (!ch) return;
    if (State.done.has(ch.id)) State.done.delete(ch.id);
    else { State.done.add(ch.id); SFX.play("done"); }
    saveProgress(); refreshSidebarItem(ch.id); renderWelcomeStats();
    const btn = document.getElementById("btn-mark-done");
    btn.textContent = State.done.has(ch.id) ? "✓ 완료됨" : "✓ 학습 완료";
    btn.classList.toggle("active", State.done.has(ch.id));
  });
}

/* ===== 스캔 뷰어 (서버 이미지 기반 + 브라우저 캐시) ===== */
// Server renders each page as WebP at 2.5× PDF points. Browser caches indefinitely.
const SERVER_PAGE_SCALE = 2.5;

async function loadChapterScan(ch) {
  document.getElementById("scan-ann-overlay").innerHTML = "";
  State.panX = 0; State.panY = 0; State.zoomLevel = 1.0;
  State.currentScale = null;  // recompute from viewer size on first render
  applyTransform();

  // Use concept-only page range (excludes 핵심문제 pages)
  State.chapterStartPage = ch.conceptStartPage || ch.startPage || 1;
  State.chapterEndPage   = ch.conceptEndPage   || ch.endPage   || 999;

  try {
    await showSpread(State.chapterStartPage);
    State.annPanelChapter = null;
    renderAnnotationList(null);
    preRenderChapter(State.chapterStartPage, State.chapterEndPage);
  } catch (err) {
    console.error("뷰어 오류:", err);
  } finally {
    document.getElementById("scan-loading").classList.add("hidden");
  }
}

async function showSpread(leftPageNum) {
  leftPageNum = Math.max(State.chapterStartPage,
                Math.min(leftPageNum, State.chapterEndPage));
  State.currentLeftPage = leftPageNum;
  const rightPageNum = leftPageNum + 1;
  const lCanvas = document.getElementById("scan-page-left");
  const rCanvas = document.getElementById("scan-page-right");
  const rightExists = rightPageNum <= State.chapterEndPage;

  // ── 캐시 히트 시 즉시 표시 ──
  const lCached = State.pageCache.get(leftPageNum);
  const rCached = State.pageCache.get(rightPageNum);

  if (lCached) blitCache(lCached, lCanvas, "hl-canvas-left");
  if (rCached && rightExists) blitCache(rCached, rCanvas, "hl-canvas-right");
  else if (!rightExists && lCached) renderBlankCanvas(rCanvas, lCanvas);

  if (lCached && (rCached || !rightExists)) {
    finishSpreadUI(leftPageNum);
    preRenderNeighbors(leftPageNum);
    return;
  }

  // ── 캐시 미스: 서버에서 이미지 fetch ──
  document.getElementById("scan-loading").classList.remove("hidden");
  try {
    const tasks = [];
    if (!lCached) tasks.push(preRenderOne(leftPageNum));
    if (!rCached && rightExists) tasks.push(preRenderOne(rightPageNum));
    else if (!rightExists) renderBlankCanvas(rCanvas, lCanvas);
    await Promise.all(tasks);

    const lNew = State.pageCache.get(leftPageNum);
    const rNew = State.pageCache.get(rightPageNum);
    if (lNew) blitCache(lNew, lCanvas, "hl-canvas-left");
    if (rNew && rightExists) blitCache(rNew, rCanvas, "hl-canvas-right");
    else if (!rightExists && lNew) renderBlankCanvas(rCanvas, lCanvas);

    // 텍스트 레이어 백그라운드 로드 (AI·형광펜 스냅용, PDF.js 지연 로딩)
    const scale = State.currentScale || 1;
    loadPageText(leftPageNum, scale);
    if (rightExists) loadPageText(rightPageNum, scale);
  } finally {
    document.getElementById("scan-loading").classList.add("hidden");
  }

  finishSpreadUI(leftPageNum);
  preRenderNeighbors(leftPageNum);
}

function finishSpreadUI(leftPageNum) {
  renderPageBadges(State.currentChapter?.id, leftPageNum);
  drawHighlightsOnPage(State.currentChapter?.id, leftPageNum);
  const right = Math.min(leftPageNum + 1, State.chapterEndPage);
  document.getElementById("scan-page-info").textContent = `${leftPageNum}–${right} / ${State.chapterEndPage}`;
  document.getElementById("scan-page-input").value = leftPageNum;
  document.getElementById("btn-scan-prev").disabled = leftPageNum <= State.chapterStartPage;
  document.getElementById("btn-scan-next").disabled = leftPageNum + 2 > State.chapterEndPage;
}

async function renderAndCache(pageNum, canvasEl, displayScale, hlId) {
  await preRenderOne(pageNum);
  const cached = State.pageCache.get(pageNum);
  if (cached) blitCache(cached, canvasEl, hlId);
}

function blitCache(offscreen, canvasEl, hlId) {
  const cssW = offscreen._cssWidth  || offscreen.width;
  const cssH = offscreen._cssHeight || offscreen.height;
  canvasEl.width  = offscreen.width;
  canvasEl.height = offscreen.height;
  canvasEl.style.width  = cssW + "px";
  canvasEl.style.height = cssH + "px";
  canvasEl._cssWidth  = cssW;
  canvasEl._cssHeight = cssH;
  canvasEl.getContext("2d").drawImage(offscreen, 0, 0);
  const hl = document.getElementById(hlId);
  if (hl) {
    hl.width  = offscreen.width;
    hl.height = offscreen.height;
    hl.style.width  = cssW + "px";
    hl.style.height = cssH + "px";
    hl._cssWidth  = cssW;
    hl._cssHeight = cssH;
  }
}

async function preRenderNeighbors(leftPageNum) {
  const immediate = [leftPageNum + 2, leftPageNum + 3, leftPageNum - 2, leftPageNum - 1];
  await Promise.all(immediate.map(p => preRenderOne(p)));
}

// In-flight deduplication: same page requested by multiple callers shares one HTTP request.
const _fetchCache = new Map();  // pageNum → Promise (while in flight)

async function preRenderOne(p) {
  if (State.pageCache.has(p)) return;
  if (p < 1) return;
  if (_fetchCache.has(p)) return _fetchCache.get(p);  // join existing request

  const promise = (async () => {
    try {
      const img = new Image();
      img.src = `/static/pages/page_${p}.webp`;
      await img.decode();   // async decode — won't block main thread on drawImage
      if (!State.currentScale) {
        const wrap = document.getElementById("scan-wrap");
        const availH = Math.max(300, wrap.clientHeight - 16);
        const availW = Math.max(200, (wrap.clientWidth - 40) / 2);
        const pdfW = img.naturalWidth  / SERVER_PAGE_SCALE;
        const pdfH = img.naturalHeight / SERVER_PAGE_SCALE;
        State.currentScale = Math.min(availH / pdfH, availW * 1.8 / pdfW);
      }
      const cssW = (img.naturalWidth  / SERVER_PAGE_SCALE) * State.currentScale;
      const cssH = (img.naturalHeight / SERVER_PAGE_SCALE) * State.currentScale;
      const off = document.createElement("canvas");
      off.width = img.naturalWidth; off.height = img.naturalHeight;
      off._cssWidth = cssW; off._cssHeight = cssH;
      off.getContext("2d").drawImage(img, 0, 0);
      State.pageCache.set(p, off);
    } catch (e) {
      console.warn(`페이지 이미지 로드 실패: page_${p}.webp`, e);
    } finally {
      _fetchCache.delete(p);
    }
  })();

  _fetchCache.set(p, promise);
  return promise;
}

async function preRenderChapter(startPage, endPage) {
  const pages = [];
  for (let p = startPage; p <= endPage; p++) {
    if (!State.pageCache.has(p) && !_fetchCache.has(p)) pages.push(p);
  }
  // Load all chapter pages in parallel — deduplication prevents double-fetches.
  // Browser limits connections to ~6 per host, so this is safe even for large chapters.
  await Promise.all(pages.map(p => preRenderOne(p)));
}

/* calcScale: kept for AI-drag feature; uses pdfDoc lazily */
async function calcScale(pageNum) {
  return State.currentScale || 1;
}

/* 텍스트 레이어 캐시 (AI 질문·형광펜 스냅용) — PDF.js 지연 로딩 */
async function loadPageText(pageNum, displayScale) {
  if (State.textCache.has(pageNum)) return;
  try {
    // Lazy-init PDF.js — only needed for text extraction, not for rendering
    if (!State.pdfDoc) {
      State.pdfDoc = await pdfjsLib.getDocument("/pdf").promise;
      State.pdfTotalPages = State.pdfDoc.numPages;
    }
    const page = await State.pdfDoc.getPage(pageNum);
    const vp   = page.getViewport({ scale: displayScale });
    const tc   = await page.getTextContent();
    const items = [];
    tc.items.forEach(item => {
      if (!item.str.trim()) return;
      const [a,,,,tx, ty] = item.transform;
      const fontSize = Math.abs(a) * displayScale;
      const [cx, cy] = vp.convertToViewportPoint(tx, ty);
      const w = item.width * displayScale;
      items.push({ x: cx, y: cy - fontSize, w: Math.max(w, 4), h: fontSize * 1.35 });
    });
    State.textCache.set(pageNum, items);
  } catch (_) {}
}

function renderBlankCanvas(canvasEl, refCanvas) {
  const cssW = refCanvas._cssWidth  || parseFloat(refCanvas.style.width)  || refCanvas.width;
  const cssH = refCanvas._cssHeight || parseFloat(refCanvas.style.height) || refCanvas.height;
  canvasEl.width  = refCanvas.width;
  canvasEl.height = refCanvas.height;
  canvasEl.style.width  = cssW + "px";
  canvasEl.style.height = cssH + "px";
  canvasEl._cssWidth  = cssW;
  canvasEl._cssHeight = cssH;
  const ctx = canvasEl.getContext("2d");
  ctx.fillStyle = "#e0e0e0";
  ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
}

function setupScanNav() {
  document.getElementById("btn-scan-prev").addEventListener("click", () => {
    SFX.play("flip"); showSpread(State.currentLeftPage - 2);
  });
  document.getElementById("btn-scan-next").addEventListener("click", () => {
    SFX.play("flip"); showSpread(State.currentLeftPage + 2);
  });
  document.getElementById("btn-scan-goto").addEventListener("click", () => {
    const v = parseInt(document.getElementById("scan-page-input").value);
    if (!isNaN(v)) showSpread(v);
  });
  document.getElementById("scan-page-input").addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("btn-scan-goto").click();
  });
  document.getElementById("btn-clear-anns").addEventListener("click", () => {
    const ch = State.currentChapter; if (!ch) return;
    if (!confirm("이 챕터의 모든 AI 질문 기록을 삭제할까요?")) return;
    delete State.annotations[ch.id];
    saveAnnotations();
    renderAnnotationList(State.annPanelChapter);
    renderPageBadges(ch.id, State.currentLeftPage);
  });

  // 사이드바 토글
  document.getElementById("btn-toggle-sidebar").addEventListener("click", () => {
    const sb = document.getElementById("study-sidebar");
    sb.classList.toggle("collapsed");
    document.getElementById("btn-toggle-sidebar").textContent = sb.classList.contains("collapsed") ? "▷" : "◁";
  });
  document.getElementById("btn-toggle-annpanel").addEventListener("click", () => {
    const ap = document.getElementById("scan-ann-panel");
    ap.classList.toggle("collapsed");
    document.getElementById("btn-toggle-annpanel").textContent = ap.classList.contains("collapsed") ? "◁" : "▷";
  });
}

/* ===== 드래그 선택 → AI 질문 / 형광펜 / 패닝 ===== */
function setupDragSelect() {
  const overlay = document.getElementById("scan-drag-overlay");
  const wrap    = document.getElementById("scan-wrap");
  let selBox = null;

  overlay.addEventListener("mousedown", e => {
    if (e.button !== 0) return;
    if (State.hlMode)  { hlStartStroke(e); return; }
    if (State.panMode) {
      State._panStart = { mx: e.clientX, my: e.clientY, px: State.panX, py: State.panY };
      overlay.style.cursor = "grabbing";
      return;
    }
    const r = overlay.getBoundingClientRect();
    State._drag = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (selBox) { selBox.remove(); selBox = null; }
  });

  overlay.addEventListener("mousemove", e => {
    if (State.hlMode)  { hlContinueStroke(e); return; }
    if (State.panMode && State._panStart) {
      State.panX = State._panStart.px + (e.clientX - State._panStart.mx);
      State.panY = State._panStart.py + (e.clientY - State._panStart.my);
      applyTransform();
      return;
    }
    if (!State._drag) return;
    const r  = overlay.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const d  = State._drag;
    if (!selBox) {
      selBox = document.createElement("div");
      selBox.className = "drag-sel-box";
      document.getElementById("scan-book-wrap").appendChild(selBox);
    }
    Object.assign(selBox.style, {
      left:   Math.min(d.x, cx) + "px",
      top:    Math.min(d.y, cy) + "px",
      width:  Math.abs(cx - d.x) + "px",
      height: Math.abs(cy - d.y) + "px",
    });
  });

  overlay.addEventListener("mouseup", e => {
    if (State.hlMode) { hlFinishStroke(); return; }
    if (State.panMode) {
      State._panStart = null;
      overlay.style.cursor = "grab";
      return;
    }
    if (!State._drag) return;
    const r  = overlay.getBoundingClientRect();
    const x2 = e.clientX - r.left, y2 = e.clientY - r.top;
    const d  = State._drag;
    State._drag = null;
    if (selBox) { selBox.remove(); selBox = null; }

    const w = Math.abs(x2 - d.x), h = Math.abs(y2 - d.y);
    if (w < 15 || h < 15) return;

    const totalW = r.width, totalH = r.height;
    const relRect = {
      x: Math.min(d.x, x2) / totalW,
      y: Math.min(d.y, y2) / totalH,
      w: w / totalW,
      h: h / totalH,
    };
    const crop = cropSpreadRegion(relRect);
    State._pendingCrop = crop;
    State._pendingRect = relRect;
    showAnnotationQueryModal(crop);
  });

  overlay.addEventListener("mouseleave", () => {
    if (State.hlMode) hlFinishStroke();
    if (State.panMode) { State._panStart = null; return; }
    State._drag = null;
    if (selBox) { selBox.remove(); selBox = null; }
  });
}

/* 두 페이지 스프레드에서 선택 영역 크롭 */
function cropSpreadRegion(rel) {
  const lc  = document.getElementById("scan-page-left");
  const rc  = document.getElementById("scan-page-right");
  const div = document.querySelector(".scan-page-divider");

  const lw = lc.offsetWidth, lh = lc.offsetHeight;
  const rw = rc.offsetWidth;
  const dw = div ? div.offsetWidth : 3;
  const totalW = lw + dw + rw;

  // 합성 캔버스 (CSS 픽셀 기준, drawImage가 자동 스케일)
  const comp = document.createElement("canvas");
  comp.width  = totalW;
  comp.height = lh;
  const ctx = comp.getContext("2d");
  ctx.drawImage(lc, 0, 0, lw, lh);
  ctx.drawImage(rc, lw + dw, 0, rw, lh);

  const cx = Math.round(rel.x * totalW);
  const cy = Math.round(rel.y * lh);
  const cw = Math.max(8, Math.round(rel.w * totalW));
  const ch = Math.max(8, Math.round(rel.h * lh));

  const crop = document.createElement("canvas");
  crop.width  = cw;
  crop.height = ch;
  crop.getContext("2d").drawImage(comp, cx, cy, cw, ch, 0, 0, cw, ch);
  return crop.toDataURL("image/png");
}

/* ===== 주석 모달 ===== */
function setupAnnotationModal() {
  const modal  = document.getElementById("ann-query-modal");
  const cancel = () => modal.classList.add("hidden");
  document.getElementById("btn-ann-cancel").addEventListener("click", cancel);
  document.getElementById("btn-ann-cancel2").addEventListener("click", cancel);
  modal.addEventListener("click", e => { if (e.target === modal) cancel(); });

  document.getElementById("btn-ann-submit").addEventListener("click", async () => {
    const question = document.getElementById("ann-query-input").value.trim();
    const crop     = State._pendingCrop;
    const relRect  = State._pendingRect;
    if (!crop || !relRect) return;

    const submitBtn = document.getElementById("btn-ann-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "AI 답변 중...";
    document.getElementById("ann-query-input").disabled = true;

    try {
      const res  = await fetch("/api/ask-vision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: crop, question }),
      });
      const { answer, error } = await res.json();
      if (error) throw new Error(error);

      const ch = State.currentChapter;
      if (!State.annotations[ch.id]) State.annotations[ch.id] = [];
      const ann = {
        id:       "ann_" + Date.now(),
        leftPage: State.currentLeftPage,
        rx: relRect.x, ry: relRect.y, rw: relRect.w, rh: relRect.h,
        question: question || "이 내용을 설명해주세요.",
        answer,
        crop,
        timestamp: new Date().toISOString(),
      };
      State.annotations[ch.id].push(ann);
      saveAnnotations();

      modal.classList.add("hidden");
      renderAnnotationList(State.annPanelChapter);
      renderPageBadges(ch.id, State.currentLeftPage);
      SFX.play("success");
    } catch (err) {
      alert("AI 오류: " + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "AI에게 질문 →";
      document.getElementById("ann-query-input").disabled = false;
    }
  });
}

function showAnnotationQueryModal(cropDataUrl) {
  document.getElementById("ann-query-preview").src = cropDataUrl;
  document.getElementById("ann-query-input").value = "";
  document.getElementById("ann-query-modal").classList.remove("hidden");
  document.getElementById("ann-query-input").focus();
}

/* ===== 주석 렌더링 ===== */
function renderPageBadges(chId, leftPageNum) {
  const overlay = document.getElementById("scan-ann-overlay");
  overlay.innerHTML = "";
  if (!chId) return;
  const anns = (State.annotations[chId] || []).filter(a => a.leftPage === leftPageNum);
  anns.forEach((ann, i) => {
    const badge = document.createElement("div");
    badge.className = "ann-badge";
    badge.textContent = i + 1;
    // rx,ry는 스프레드 전체 기준 상대 좌표
    badge.style.left = (ann.rx + ann.rw / 2) * 100 + "%";
    badge.style.top  = (ann.ry + ann.rh / 2) * 100 + "%";
    badge.addEventListener("click", e => { e.stopPropagation(); showAnnPopup(ann, badge); });
    overlay.appendChild(badge);
  });
}

function showAnnPopup(ann, anchor) {
  document.querySelectorAll(".ann-popup").forEach(p => p.remove());
  const popup = document.createElement("div");
  popup.className = "ann-popup";
  popup.innerHTML = `
    <button class="ann-popup-close">✕</button>
    <div class="ann-popup-q">Q. ${escHtml(ann.question)}</div>
    <div class="ann-popup-a">${escHtml(ann.answer)}</div>`;
  popup.querySelector(".ann-popup-close").addEventListener("click", () => popup.remove());
  document.body.appendChild(popup);

  const rect = anchor.getBoundingClientRect();
  popup.style.top  = (rect.bottom + 8) + "px";
  popup.style.left = Math.min(rect.left, window.innerWidth - 340) + "px";
  document.addEventListener("click", () => popup.remove(), { once: true, capture: true });
}

function renderAnnotationList(filterChId) {
  State.annPanelChapter = filterChId ?? State.annPanelChapter;

  // 챕터 탭 렌더
  const tabsEl = document.getElementById("ann-chapter-tabs");
  const chsWithAnns = State.chapters.filter(ch => (State.annotations[ch.id]||[]).length > 0);
  tabsEl.innerHTML = `<button class="ann-ch-tab ${!State.annPanelChapter ? "active":""}" data-ch="">전체</button>` +
    chsWithAnns.map(ch => {
      const cnt = (State.annotations[ch.id]||[]).length;
      return `<button class="ann-ch-tab ${State.annPanelChapter===ch.id?"active":""}" data-ch="${ch.id}">${ch.title} <span class="ann-cnt">(${cnt})</span></button>`;
    }).join("");
  tabsEl.querySelectorAll(".ann-ch-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      State.annPanelChapter = btn.dataset.ch || null;
      renderAnnotationList(State.annPanelChapter);
    });
  });

  // 표시할 주석 수집
  const list = document.getElementById("ann-list");
  let entries = []; // { ann, chId, chTitle }
  const chFilter = State.annPanelChapter;
  const targets = chFilter
    ? State.chapters.filter(c => c.id === chFilter)
    : chsWithAnns;

  targets.forEach(ch => {
    (State.annotations[ch.id]||[]).forEach(ann => entries.push({ ann, chId: ch.id, chTitle: ch.title }));
  });

  if (!entries.length) {
    list.innerHTML = '<p class="ann-empty">기록된 AI 질문이 없습니다</p>';
    return;
  }

  list.innerHTML = entries.map(({ ann, chId, chTitle }, i) => `
    <div class="ann-card" data-ann-idx="${i}" style="cursor:pointer">
      <div class="ann-card-head">
        <div class="ann-badge-sm">${i + 1}</div>
        <div class="ann-card-q">${escHtml(ann.question)}</div>
        <div class="ann-card-page">p.${ann.leftPage||"?"}</div>
      </div>
      ${!chFilter ? `<div style="padding:2px 10px 4px;font-size:10px;color:var(--text3);background:var(--bg)">${escHtml(chTitle)}</div>` : ""}
      <img class="ann-card-crop" src="${ann.crop}" alt="">
      <div class="ann-card-ans">${escHtml(ann.answer)}</div>
    </div>`).join("");

  list.querySelectorAll(".ann-card").forEach((card, i) => {
    card.addEventListener("click", () => showAnnDetail(entries[i].ann));
  });
}

/* ===== transform 기반 뷰어 이동/줌 ===== */
function applyTransform() {
  const bw = document.getElementById("scan-book-wrap");
  if (!bw) return;
  bw.style.transform = `translate(${State.panX}px, ${State.panY}px) scale(${State.zoomLevel})`;
  bw.style.transformOrigin = "center center";
}

function setupResizePanels() {
  function makeResizable(handleEl, panelEl, getDelta) {
    if (!handleEl || !panelEl) return;
    let startX = 0, dragging = false;
    handleEl.addEventListener("mousedown", e => {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      handleEl.classList.add("dragging");
      panelEl.style.transition = "none";
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });
    document.addEventListener("mousemove", e => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      startX = e.clientX;
      getDelta(dx);
    });
    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      handleEl.classList.remove("dragging");
      panelEl.style.transition = "";
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });
  }

  const sidebar = document.getElementById("study-sidebar");
  makeResizable(
    document.getElementById("resize-sidebar"), sidebar,
    dx => {
      if (sidebar.classList.contains("collapsed")) return;
      const w = Math.max(160, Math.min(480, sidebar.offsetWidth + dx));
      sidebar.style.width = w + "px";
      sidebar.style.minWidth = w + "px";
    }
  );

  const annPanel = document.getElementById("scan-ann-panel");
  makeResizable(
    document.getElementById("resize-annpanel"), annPanel,
    dx => {
      if (annPanel.classList.contains("collapsed")) return;
      const w = Math.max(160, Math.min(520, annPanel.offsetWidth - dx));
      annPanel.style.width = w + "px";
    }
  );
}

function setupZoom() {
  const wrap = document.getElementById("scan-wrap");
  wrap.addEventListener("wheel", e => {
    if (!State.currentChapter) return;
    e.preventDefault();
    const factor = Math.pow(1.06, -e.deltaY / 100);
    const newZoom = Math.max(0.3, Math.min(5.0, State.zoomLevel * factor));

    // 커서 위치 기준으로 줌 (커서 아래 콘텐츠가 고정)
    const bw   = document.getElementById("scan-book-wrap");
    const bRect = bw.getBoundingClientRect();
    const dx = e.clientX - (bRect.left + bRect.width  / 2);
    const dy = e.clientY - (bRect.top  + bRect.height / 2);

    State.panX += dx * (1 - newZoom / State.zoomLevel);
    State.panY += dy * (1 - newZoom / State.zoomLevel);
    State.zoomLevel = newZoom;
    applyTransform();
  }, { passive: false });
}

/* ===== 휠 클릭 & 이동 모드 패닝 (transform 기반, XY 완전 자유) ===== */
function setupPan() {
  const wrap = document.getElementById("scan-wrap");
  let panStart = null;

  function startPan(mx, my) {
    panStart = { mx, my, px: State.panX, py: State.panY };
  }
  function movePan(mx, my) {
    if (!panStart) return;
    State.panX = panStart.px + (mx - panStart.mx);
    State.panY = panStart.py + (my - panStart.my);
    applyTransform();
  }
  function endPan() { panStart = null; }

  // 휠 클릭 패닝 (항상 사용 가능)
  document.addEventListener("mousedown", e => {
    if (e.button !== 1) return;
    e.preventDefault();
    const wr = wrap.getBoundingClientRect();
    if (e.clientX < wr.left || e.clientX > wr.right || e.clientY < wr.top || e.clientY > wr.bottom) return;
    startPan(e.clientX, e.clientY);
    wrap.style.cursor = "grabbing";
  });
  document.addEventListener("mousemove", e => {
    if (e.buttons & 4) movePan(e.clientX, e.clientY);  // 휠 버튼 지속 체크
  });
  document.addEventListener("mouseup", e => {
    if (e.button !== 1) return;
    endPan();
    wrap.style.cursor = "";
  });
  wrap.addEventListener("mousedown", e => { if (e.button === 1) e.preventDefault(); });
}

/* ===== 마크다운 렌더 ===== */
function renderMarkdown(text) {
  if (!text) return "";
  try { return marked.parse(String(text)); }
  catch (_) { return escHtml(String(text)).replace(/\n/g, "<br>"); }
}

// Convert non-standard math delimiters to $...$ so KaTeX can render them
function normalizeLatex(text) {
  if (!text) return text;
  // \[...\] → $$...$$
  text = text.replace(/\\\[([^]*?)\\\]/g, (_, m) => `$$${m}$$`);
  // \(...\) → $...$
  text = text.replace(/\\\(([^]*?)\\\)/g, (_, m) => `$${m}$`);
  // [ LaTeX ] → $$...$$ when content contains LaTeX-like chars
  text = text.replace(/\[\s*([^\[\]]{3,}?)\s*\]/g, (match, inner) => {
    if (/[\\^_{}]/.test(inner)) return `$$${inner}$$`;
    return match;
  });
  return text;
}

/* ===== 형광펜 ===== */
function setupHighlighter() {
  document.getElementById("btn-tool-select").addEventListener("click", () => setToolMode("select"));
  document.getElementById("btn-tool-hl").addEventListener("click",     () => setToolMode("hl"));
  document.getElementById("btn-tool-pan").addEventListener("click",    () => setToolMode("pan"));

  // 색상 선택
  document.querySelectorAll(".hl-color-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      State.hlColor = btn.dataset.color;
      State.hlTool  = "pen";
      document.querySelectorAll(".hl-color-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("btn-hl-eraser")?.classList.remove("active");
    });
  });

  // 지우개
  document.getElementById("btn-hl-eraser").addEventListener("click", () => {
    State.hlTool = State.hlTool === "eraser" ? "pen" : "eraser";
    document.getElementById("btn-hl-eraser").classList.toggle("active", State.hlTool === "eraser");
    document.querySelectorAll(".hl-color-btn").forEach(b => b.classList.toggle("active",
      b.dataset.color === State.hlColor && State.hlTool !== "eraser"));
  });

  // 스냅 토글
  document.getElementById("btn-hl-snap").addEventListener("click", () => {
    State.hlSnap = !State.hlSnap;
    document.getElementById("btn-hl-snap").classList.toggle("active", State.hlSnap);
  });

  // 필터
  document.querySelectorAll(".hl-flt-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const c = btn.dataset.color;
      document.querySelectorAll(".hl-flt-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      State.hlFilter = c === "all" ? new Set(Object.keys(HL_COLORS)) : new Set([c]);
      drawHighlightsOnPage(State.currentChapter?.id, State.currentLeftPage);
    });
  });

  // 취소
  document.getElementById("btn-hl-undo").addEventListener("click", () => {
    const ch = State.currentChapter; if (!ch) return;
    const pd = State.highlights?.[ch.id]?.[State.currentLeftPage];
    if (!pd) return;
    for (const side of ["right","left"]) {
      if (pd[side]?.length) { pd[side].pop(); break; }
    }
    saveHighlights();
    drawHighlightsOnPage(ch.id, State.currentLeftPage);
  });

  // 전체 지우기
  document.getElementById("btn-hl-clear").addEventListener("click", () => {
    const ch = State.currentChapter; if (!ch) return;
    if (!confirm("이 페이지의 모든 형광펜을 지울까요?")) return;
    if (State.highlights[ch.id]) delete State.highlights[ch.id][State.currentLeftPage];
    saveHighlights();
    drawHighlightsOnPage(ch.id, State.currentLeftPage);
  });
}

function setToolMode(mode) {
  // mode: "select" | "hl" | "pan"
  State.hlMode  = mode === "hl";
  State.panMode = mode === "pan";
  if (!State.hlMode) State.hlTool = "pen";

  const overlay = document.getElementById("scan-drag-overlay");
  overlay.style.cursor = mode === "pan" ? "grab" : "crosshair";

  document.getElementById("btn-tool-select").classList.toggle("active", mode === "select");
  document.getElementById("btn-tool-hl").classList.toggle("active",     mode === "hl");
  document.getElementById("btn-tool-pan").classList.toggle("active",    mode === "pan");

  ["hl-colors","hl-legend","hl-filter-wrap","hl-actions"].forEach(id =>
    document.getElementById(id).classList.toggle("hidden", mode !== "hl"));

  const hints = {
    select: "💡 드래그 → AI 질문",
    hl:     "🖊 드래그하여 형광펜 표시 / 지우개 선택 후 드래그로 삭제",
    pan:    "✋ 드래그하여 페이지 이동",
  };
  document.getElementById("scan-drag-hint").textContent = hints[mode] || hints.select;
}

/* 형광펜 그리기 */
function hlStartStroke(e) {
  State._hlLivePoints = [];
  const info = hlGetCanvasCoords(e.clientX, e.clientY);
  if (!info) return;
  State._hlLivePath = { tool: State.hlTool, color: State.hlColor, side: info.side };
  State._hlLivePoints = [{ x: info.x, y: info.y }];
}

function hlContinueStroke(e) {
  if (!State._hlLivePath) return;
  const info = hlGetCanvasCoords(e.clientX, e.clientY);
  if (!info || info.side !== State._hlLivePath.side) return;
  State._hlLivePoints.push({ x: info.x, y: info.y });

  const hlId = info.side === "left" ? "hl-canvas-left" : "hl-canvas-right";
  const canvas = document.getElementById(hlId);
  const ctx = canvas.getContext("2d");

  if (State.hlTool === "eraser") {
    // 지우개: 현재 좌표 실시간 preview (빨간 점)
    redrawHlCanvas(canvas, State.currentChapter?.id, State.currentLeftPage, info.side);
    hlDrawEraserPreview(ctx, State._hlLivePoints);
  } else {
    // 펜: 라이브 획 preview
    redrawHlCanvas(canvas, State.currentChapter?.id, State.currentLeftPage, info.side);
    hlDrawLiveLine(ctx, State._hlLivePoints, State.hlColor);
  }
}

function hlFinishStroke() {
  const path = State._hlLivePath;
  const pts  = State._hlLivePoints;
  State._hlLivePath = null;
  State._hlLivePoints = [];

  if (!path || pts.length < 2) return;
  const ch = State.currentChapter; if (!ch) return;

  if (path.tool === "eraser") {
    // 지우개: 교차하는 획 제거
    hlEraseIntersecting(ch.id, path.side, pts);
  } else {
    // 펜: 스냅 또는 freehand 저장
    const entry = hlBuildEntry(path.side, path.color, pts);
    if (!State.highlights[ch.id]) State.highlights[ch.id] = {};
    if (!State.highlights[ch.id][State.currentLeftPage])
      State.highlights[ch.id][State.currentLeftPage] = { left:[], right:[] };
    State.highlights[ch.id][State.currentLeftPage][path.side].push(entry);
  }
  saveHighlights();
  drawHighlightsOnPage(ch.id, State.currentLeftPage);
}

function hlBuildEntry(side, color, points) {
  // 텍스트 스냅 모드: 드로잉 영역과 겹치는 텍스트 라인을 사각형으로 변환
  if (State.hlSnap) {
    const pageNum = side === "left" ? State.currentLeftPage : State.currentLeftPage + 1;
    const textItems = State.textCache.get(pageNum);
    if (textItems?.length) {
      const minX = Math.min(...points.map(p => p.x));
      const maxX = Math.max(...points.map(p => p.x));
      const minY = Math.min(...points.map(p => p.y));
      const maxY = Math.max(...points.map(p => p.y));
      const lc   = document.getElementById("scan-page-left");
      const cssW = lc?._cssWidth || parseFloat(lc?.style.width) || lc?.width || 600;
      const lw   = cssW * 0.025;
      const padY = lw;

      // 드로잉 Y 범위와 겹치는 텍스트 아이템 수집
      const hit = textItems.filter(ti =>
        ti.y < maxY + padY && ti.y + ti.h > minY - padY &&
        ti.x < maxX + 10   && ti.x + ti.w > minX - 10
      );
      if (hit.length > 0) {
        // 라인 별 그룹 (Y 기준 ±4px)
        const lines = [];
        hit.forEach(ti => {
          let found = lines.find(l => Math.abs(l.y - ti.y) < ti.h * 0.5);
          if (found) {
            found.x1 = Math.min(found.x1, ti.x);
            found.x2 = Math.max(found.x2, ti.x + ti.w);
            found.y1 = Math.min(found.y1, ti.y);
            found.y2 = Math.max(found.y2, ti.y + ti.h);
            found.y  = found.y1;
          } else {
            lines.push({ y: ti.y, x1: ti.x, x2: ti.x + ti.w, y1: ti.y, y2: ti.y + ti.h });
          }
        });
        return {
          type: "rects",
          color,
          rects: lines.map(l => ({ x: l.x1 - 2, y: l.y1 - 2, w: l.x2 - l.x1 + 4, h: l.y2 - l.y1 + 4 })),
        };
      }
    }
  }
  // freehand fallback
  return { type: "path", color, points };
}

/* 지우개: 스트로크 포인트와 가까운 획 제거 */
function hlEraseIntersecting(chId, side, eraserPts) {
  const pd = State.highlights?.[chId]?.[State.currentLeftPage]?.[side];
  if (!pd) return;
  const lc = document.getElementById("scan-page-left");
  const cssW = lc?._cssWidth || parseFloat(lc?.style.width) || lc?.width || 600;
  const radius = cssW * 0.04;
  State.highlights[chId][State.currentLeftPage][side] = pd.filter(entry => {
    const entryPts = entry.type === "rects"
      ? entry.rects.flatMap(r => [
          {x:r.x,y:r.y},{x:r.x+r.w,y:r.y},{x:r.x,y:r.y+r.h},{x:r.x+r.w,y:r.y+r.h}
        ])
      : entry.points || [];
    return !entryPts.some(pp =>
      eraserPts.some(ep => Math.hypot(pp.x - ep.x, pp.y - ep.y) < radius)
    );
  });
}

// 좌표는 CSS(display) 픽셀 기준 — RENDER_SCALE과 무관하게 일관성 유지
// getBoundingClientRect()는 zoom 적용된 뷰포트 크기를 반환하므로 zoomLevel로 나눠 CSS 좌표로 환산
function hlGetCanvasCoords(clientX, clientY) {
  const z = State.zoomLevel || 1;
  for (const side of ["left","right"]) {
    const c = document.getElementById(side === "left" ? "scan-page-left" : "scan-page-right");
    const r = c.getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
      return { side, x: (clientX - r.left) / z, y: (clientY - r.top) / z };
    }
  }
  return null;
}

function drawHighlightsOnPage(chId, leftPage) {
  ["left","right"].forEach(side => {
    const canvas = document.getElementById(side === "left" ? "hl-canvas-left" : "hl-canvas-right");
    if (canvas) redrawHlCanvas(canvas, chId, leftPage, side);
  });
}

function redrawHlCanvas(canvas, chId, leftPage, side) {
  const ctx  = canvas.getContext("2d");
  const cssW = canvas._cssWidth || parseFloat(canvas.style.width) || canvas.width;
  const ratio = canvas.width / cssW;  // physical/css
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(ratio, ratio);  // draw in CSS coords
  const entries = State.highlights?.[chId]?.[leftPage]?.[side] || [];
  entries.forEach(entry => {
    if (!State.hlFilter.has(entry.color)) return;
    hlRenderEntry(ctx, entry, cssW);
  });
  ctx.restore();
}

function hlRenderEntry(ctx, entry, cssW) {
  // ctx는 이미 CSS 좌표계로 scale된 상태 (redrawHlCanvas에서 설정)
  const width = cssW || ctx.canvas.width;
  const color = HL_COLORS[entry.color]?.hex || "#FFE600";
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = color;
  ctx.strokeStyle = color;

  if (entry.type === "rects") {
    entry.rects.forEach(r => ctx.fillRect(r.x, r.y, r.w, r.h));
  } else {
    if (!entry.points || entry.points.length < 2) { ctx.restore(); return; }
    const lw = width * 0.025 || 12;
    ctx.lineWidth = lw; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(entry.points[0].x, entry.points[0].y);
    entry.points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.stroke();
  }
  ctx.restore();
}

function hlDrawLiveLine(ctx, points, color) {
  if (points.length < 2) return;
  const cssW  = ctx.canvas._cssWidth || parseFloat(ctx.canvas.style.width) || ctx.canvas.width;
  const ratio = ctx.canvas.width / cssW;
  const lw = cssW * 0.025 || 12;
  ctx.save();
  ctx.scale(ratio, ratio);
  ctx.globalAlpha = 0.45;
  ctx.globalCompositeOperation = "multiply";
  ctx.strokeStyle = HL_COLORS[color]?.hex || "#FFE600";
  ctx.lineWidth = lw; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
  ctx.stroke();
  ctx.restore();
}

function hlDrawEraserPreview(ctx, points) {
  if (!points.length) return;
  const cssW  = ctx.canvas._cssWidth || parseFloat(ctx.canvas.style.width) || ctx.canvas.width;
  const ratio = ctx.canvas.width / cssW;
  const radius = cssW * 0.04 || 20;
  const last = points[points.length - 1];
  ctx.save();
  ctx.scale(ratio, ratio);
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = "#cc0000";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(last.x, last.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/* ===== 주석 확대 모달 ===== */
function setupAnnDetail() {
  document.getElementById("btn-ann-detail-close").addEventListener("click", () => {
    document.getElementById("ann-detail-modal").classList.add("hidden");
  });
  document.getElementById("ann-detail-modal").addEventListener("click", e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add("hidden");
  });
}

function showAnnDetail(ann) {
  document.getElementById("ann-detail-title").textContent = `Q. ${ann.question}`;
  document.getElementById("ann-detail-crop").src = ann.crop;
  const ansEl = document.getElementById("ann-detail-answer");
  ansEl.innerHTML = renderMarkdown(ann.answer);
  if (window.renderMathInElement) {
    renderMathInElement(ansEl, {
      delimiters: [{ left:"$$", right:"$$", display:true }, { left:"$", right:"$", display:false }],
      throwOnError: false,
    });
  }
  document.getElementById("ann-detail-modal").classList.remove("hidden");
}

function renderWelcomeStats() {
  const el = document.getElementById("welcome-stats");
  if (!el) return;
  const total = State.chapters.length;
  const done  = State.done.size;
  const pct   = total ? Math.round((done / total) * 100) : 0;
  el.innerHTML = `
    <div class="stat-card"><div class="stat-num">${total}</div><div class="stat-label">전체 챕터</div></div>
    <div class="stat-card"><div class="stat-num">${done}</div><div class="stat-label">완료 챕터</div></div>
    <div class="stat-card"><div class="stat-num">${pct}%</div><div class="stat-label">진도율</div></div>
    <div class="stat-card"><div class="stat-num">${State.bookmarks.size}</div><div class="stat-label">북마크</div></div>`;
}

/* ===== 문제풀기 탭 ===== */
const QuizViewer = {
  crops: [],
  idx:   0,
  allCrops: [],
  selectedChoice: null,   // 현재 선택한 번호 (1-4)
  explainOpen: false,
};

const _imgPreloadSet = new Set();  // 이미 프리로드 요청한 URL

function cropUrl(crop) {
  const [x0, y0, x1, y1] = crop.bbox;
  return `/api/crop-image/${crop.page}?x0=${x0}&y0=${y0}&x1=${x1}&y1=${y1}`;
}

function preloadCropImages(crops, fromIdx) {
  const N = crops.length;
  const order = [];
  for (let d = 0; d < N; d++) {
    if (fromIdx + d < N)    order.push(fromIdx + d);
    if (d > 0 && fromIdx - d >= 0) order.push(fromIdx - d);
  }
  let active = 0;
  const MAX = 4;
  let i = 0;
  function next() {
    while (active < MAX && i < order.length) {
      const url = cropUrl(crops[order[i++]]);
      if (_imgPreloadSet.has(url)) { continue; }
      _imgPreloadSet.add(url);
      active++;
      const im = new Image();
      im.onload = im.onerror = () => { active--; next(); };
      im.src = url;
    }
  }
  next();
}

async function setupQuizTab() {
  try {
    const res = await fetch("/static/data/problem_crops.json");
    QuizViewer.allCrops = await res.json();
  } catch (_) {
    QuizViewer.allCrops = [];
  }

  // 퀴즈 결과 로드
  if (State.loggedIn) {
    try {
      const r = await fetch("/api/quiz-results");
      if (r.ok) State.quizHistory = await r.json();
    } catch (_) {}
  }

  // 챕터 필터 옵션
  const sel = document.getElementById("quiz-chapter-filter");
  const chapterIds = [...new Set(QuizViewer.allCrops.map(c => c.chapterId))];
  State.chapters.forEach(ch => {
    if (!chapterIds.includes(ch.id)) return;
    const cnt = QuizViewer.allCrops.filter(c => c.chapterId === ch.id).length;
    const opt = document.createElement("option");
    opt.value = ch.id;
    opt.textContent = `${ch.partTitle} › ${ch.title} (${cnt}문제)`;
    sel.appendChild(opt);
  });

  sel.addEventListener("change", () => {
    QuizViewer.idx = 0;
    _imgPreloadSet.clear();
    quizRender();
    preloadCropImages(quizCurrentCrops(), 0);
  });

  document.getElementById("btn-prob-prev").addEventListener("click", () => {
    QuizViewer.idx = Math.max(0, QuizViewer.idx - 1);
    quizRender();
  });
  document.getElementById("btn-prob-next").addEventListener("click", () => {
    QuizViewer.idx = Math.min(quizCurrentCrops().length - 1, QuizViewer.idx + 1);
    quizRender();
  });

  // 답안 선택 버튼
  document.querySelectorAll(".quiz-choice-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      QuizViewer.selectedChoice = parseInt(btn.dataset.choice);
      document.querySelectorAll(".quiz-choice-btn").forEach(b => b.classList.toggle("selected", b === btn));
    });
  });

  // 제출 버튼
  document.getElementById("btn-quiz-submit").addEventListener("click", quizSubmit);

  // AI 해설 토글
  document.getElementById("btn-quiz-explain").addEventListener("click", quizToggleExplain);

  document.addEventListener("keydown", e => {
    if (document.getElementById("tab-quiz").classList.contains("hidden")) return;
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (e.key === "ArrowLeft")  { QuizViewer.idx = Math.max(0, QuizViewer.idx - 1); quizRender(); }
    if (e.key === "ArrowRight") { QuizViewer.idx = Math.min(quizCurrentCrops().length - 1, QuizViewer.idx + 1); quizRender(); }
  });

  quizRender();
  preloadCropImages(quizCurrentCrops(), 0);
}

function quizCurrentCrops() {
  const chId = document.getElementById("quiz-chapter-filter").value;
  return chId
    ? QuizViewer.allCrops.filter(c => c.chapterId === chId)
    : QuizViewer.allCrops;
}

function quizRender() {
  const crops   = quizCurrentCrops();
  const empty   = document.getElementById("quiz-empty");
  const wrap    = document.getElementById("prob-card-wrap");
  const img     = document.getElementById("prob-page-img");
  const counter = document.getElementById("prob-page-counter");
  const btnPrev = document.getElementById("btn-prob-prev");
  const btnNext = document.getElementById("btn-prob-next");

  if (!crops.length) {
    empty.classList.remove("hidden");
    wrap.classList.add("hidden");
    counter.textContent = "";
    btnPrev.disabled = btnNext.disabled = true;
    quizUpdateStats([]);
    return;
  }

  QuizViewer.idx = Math.max(0, Math.min(crops.length - 1, QuizViewer.idx));
  QuizViewer.selectedChoice = null;
  QuizViewer.explainOpen = false;
  const crop = crops[QuizViewer.idx];
  const hist = State.quizHistory[crop.id] || null;

  empty.classList.add("hidden");
  wrap.classList.remove("hidden");

  // 이미지 (프리로드됐으면 즉시, 아니면 페이드)
  const url = cropUrl(crop);
  img.alt = `문제 ${crop.num}`;
  if (!_imgPreloadSet.has(url)) {
    img.style.opacity = "0.3";
    img.onload  = () => { img.style.opacity = "1"; };
    img.onerror = () => { img.style.opacity = "1"; };
  } else {
    img.style.opacity = "1";
    img.onload = img.onerror = null;
  }
  img.src = url;

  // 카드 헤더
  const badge = document.getElementById("prob-num-badge");
  badge.textContent = `문제 ${crop.num}`;
  badge.style.background = crop.partColor || "var(--accent)";
  document.getElementById("prob-chapter-info").textContent =
    `${crop.partTitle} › ${crop.chapterTitle}`;

  // 기존 결과 배지
  const resBadge = document.getElementById("prob-result-badge");
  if (hist) {
    resBadge.classList.remove("hidden", "correct", "wrong");
    resBadge.classList.add(hist.correct ? "correct" : "wrong");
    resBadge.textContent = hist.correct ? `✓ 정답 (${hist.attempts}회)` : `✗ 오답 (${hist.attempts}회)`;
  } else {
    resBadge.classList.add("hidden");
  }

  counter.textContent = `${QuizViewer.idx + 1} / ${crops.length}`;
  btnPrev.disabled = QuizViewer.idx === 0;
  btnNext.disabled = QuizViewer.idx === crops.length - 1;

  // 답안 영역
  const ansSection     = document.getElementById("quiz-answer-section");
  const resultBar      = document.getElementById("quiz-result-bar");
  const explainSection = document.getElementById("quiz-explain-section");
  const explainContent = document.getElementById("quiz-explain-content");
  const explainText    = document.getElementById("quiz-explain-text");

  if (crop.answer !== null && crop.answer !== undefined) {
    ansSection.classList.remove("hidden");
    explainSection.classList.remove("hidden");
  } else {
    ansSection.classList.add("hidden");
    explainSection.classList.add("hidden");
  }

  // 버튼 초기화
  document.querySelectorAll(".quiz-choice-btn").forEach(b => {
    b.classList.remove("selected","correct","wrong","reveal");
    b.disabled = false;
  });
  document.getElementById("btn-quiz-submit").classList.remove("hidden");
  resultBar.classList.add("hidden");
  explainContent.classList.add("hidden");
  explainText.innerHTML = "";
  document.getElementById("btn-quiz-explain").textContent = "🤖 AI 해설 보기 ▼";

  // 이미 답한 경우 결과 표시
  if (hist) {
    quizShowResult(crop, hist.selectedAnswer, hist.correct);
  }

  quizUpdateStats(crops);
}

function quizShowResult(crop, selected, isCorrect) {
  const resultBar = document.getElementById("quiz-result-bar");
  const submitBtn = document.getElementById("btn-quiz-submit");
  const labels = {1:"①", 2:"②", 3:"③", 4:"④"};

  document.querySelectorAll(".quiz-choice-btn").forEach(b => {
    b.disabled = true;
    const c = parseInt(b.dataset.choice);
    if (c === selected && !isCorrect)  b.classList.add("wrong");
    if (c === crop.answer)             b.classList.add(isCorrect && c===selected ? "correct" : "reveal");
  });

  resultBar.classList.remove("hidden","correct","wrong");
  resultBar.classList.add(isCorrect ? "correct" : "wrong");
  resultBar.textContent = isCorrect
    ? `✅ 정답입니다! (${labels[selected]}번)`
    : `❌ 틀렸습니다. 정답: ${labels[crop.answer]}번`;

  submitBtn.classList.add("hidden");
}

async function quizSubmit() {
  const crops = quizCurrentCrops();
  const crop  = crops[QuizViewer.idx];
  if (!crop || QuizViewer.selectedChoice === null) {
    alert("선택지를 먼저 클릭하세요.");
    return;
  }

  const selected   = QuizViewer.selectedChoice;
  const isCorrect  = (selected === crop.answer);

  quizShowResult(crop, selected, isCorrect);

  // 히스토리 저장
  const prev = State.quizHistory[crop.id];
  State.quizHistory[crop.id] = {
    selectedAnswer: selected,
    correct: isCorrect,
    attempts: (prev?.attempts || 0) + 1,
  };

  // 서버 저장
  if (State.loggedIn) {
    fetch("/api/quiz-result", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({problem_id: crop.id, selected_answer: selected, correct: isCorrect}),
    }).catch(() => {});
  }

  // 결과 배지 업데이트
  const resBadge = document.getElementById("prob-result-badge");
  const hist = State.quizHistory[crop.id];
  resBadge.classList.remove("hidden","correct","wrong");
  resBadge.classList.add(isCorrect ? "correct" : "wrong");
  resBadge.textContent = isCorrect ? `✓ 정답 (${hist.attempts}회)` : `✗ 오답 (${hist.attempts}회)`;

  quizUpdateStats(quizCurrentCrops());
  SFX.play(isCorrect ? "success" : "wrong");
}

async function quizToggleExplain() {
  const content  = document.getElementById("quiz-explain-content");
  const loading  = document.getElementById("quiz-explain-loading");
  const text     = document.getElementById("quiz-explain-text");
  const btn      = document.getElementById("btn-quiz-explain");
  const isOpen   = !content.classList.contains("hidden");

  if (isOpen) {
    content.classList.add("hidden");
    btn.textContent = "🤖 AI 해설 보기 ▼";
    return;
  }

  content.classList.remove("hidden");
  btn.textContent = "🤖 AI 해설 닫기 ▲";

  if (text.innerHTML.trim()) return;  // 이미 로드됨

  const crops = quizCurrentCrops();
  const crop  = crops[QuizViewer.idx];
  if (!crop) return;

  loading.classList.remove("hidden");
  text.innerHTML = "";

  try {
    const res = await fetch("/api/quiz-explain", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        problem_id: crop.id,
        answer: crop.answer,
        page: crop.page,
        bbox: crop.bbox,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    text.innerHTML = renderMarkdown(normalizeLatex(data.explanation));
    if (window.renderMathInElement) {
      renderMathInElement(text, {
        delimiters: [
          {left:"$$", right:"$$", display:true},
          {left:"\\[", right:"\\]", display:true},
          {left:"$",  right:"$",  display:false},
          {left:"\\(", right:"\\)", display:false},
        ],
        throwOnError: false,
      });
    }
  } catch (e) {
    text.innerHTML = `<span style="color:var(--danger)">해설 로드 실패: ${escHtml(e.message)}</span>`;
  } finally {
    loading.classList.add("hidden");
  }
}

function quizUpdateStats(crops) {
  const counter = document.getElementById("prob-page-counter");
  if (!crops.length) { counter.textContent = ""; return; }
  const total    = crops.length;
  const answered = crops.filter(c => State.quizHistory[c.id]).length;
  const correct  = crops.filter(c => State.quizHistory[c.id]?.correct).length;
  const idx      = QuizViewer.idx;
  counter.innerHTML =
    `<span>${idx + 1} / ${total}</span>` +
    (answered ? `&ensp;<span class="quiz-stats-bar">` +
      `<span class="stat-ok">✓${correct}</span> / ` +
      `<span class="stat-bad">✗${answered - correct}</span>` +
    `</span>` : "");
}

/* ===== AI 채팅 탭 ===== */
function setupChatTab() {
  const input = document.getElementById("chat-input");
  document.getElementById("btn-chat-send").addEventListener("click", sendChat);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  document.querySelectorAll(".quick-q").forEach(btn => {
    btn.addEventListener("click", () => {
      document.getElementById("chat-input").value = btn.dataset.q;
      sendChat();
    });
  });
}

async function sendChat() {
  const input = document.getElementById("chat-input");
  const text  = input.value.trim();
  if (!text) return;
  input.value = "";
  SFX.play("nav");

  appendChatMsg("user", text);
  State.chatHistory.push({ role: "user", content: text });

  const bubble = appendChatMsg("assistant", "");
  const thinking = document.createElement("div");
  thinking.className = "msg-thinking";
  thinking.textContent = "생각 중...";
  bubble.appendChild(thinking);

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: State.chatHistory }),
    });
    if (!res.ok) {
      const err = await res.json();
      bubble.innerHTML = `<span style="color:var(--danger)">${err.error}</span>`;
      return;
    }
    let full = "";
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    thinking.remove();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") break;
        try {
          const p = JSON.parse(data);
          if (p.text) {
            full += p.text;
            bubble.innerHTML = renderMarkdown(full);
            if (window.renderMathInElement) {
              renderMathInElement(bubble, {
                delimiters: [{ left:"$$", right:"$$", display:true }, { left:"$", right:"$", display:false }],
                throwOnError: false,
              });
            }
          }
        } catch (_) {}
      }
    }
    State.chatHistory.push({ role: "assistant", content: full });
    scrollChatToBottom();
    SFX.play("success");
  } catch (e) {
    bubble.innerHTML = `<span style="color:var(--danger)">연결 오류: ${e.message}</span>`;
  }
}

function appendChatMsg(role, text) {
  const messages = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = `chat-msg ${role}`;
  div.innerHTML = `
    <div class="msg-avatar">${role === "assistant" ? "AI" : "나"}</div>
    <div class="msg-bubble">${role === "assistant" ? renderMarkdown(text) : escHtml(text)}</div>`;
  messages.appendChild(div);
  scrollChatToBottom();
  return div.querySelector(".msg-bubble");
}

function scrollChatToBottom() {
  const el = document.getElementById("chat-messages");
  el.scrollTop = el.scrollHeight;
}

/* ===== 개념 그래프 탭 ===== */
function setupGraphTab() {
  document.getElementById("btn-graph-reset").addEventListener("click", renderGraph);
  document.querySelectorAll(".filter-type, .filter-edge").forEach(cb => cb.addEventListener("change", renderGraph));
  document.getElementById("btn-graph-goto-chapter").addEventListener("click", () => {
    const node = State.selectedGraphNode;
    if (!node || node.type !== "chapter") return;
    const ch = State.chapters.find(c => c.id === node.id);
    if (ch) { document.querySelector('[data-tab="study"]').click(); openChapter(ch); }
  });
}

function renderGraph() {
  if (!State.graphData) return;
  const wrap = document.getElementById("graph-svg-wrap");
  const svg  = document.getElementById("graph-svg");
  svg.innerHTML = "";
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;

  const showTypes = new Set([...document.querySelectorAll(".filter-type:checked")].map(c => c.value));
  const showEdges = new Set([...document.querySelectorAll(".filter-edge:checked")].map(c => c.value));
  const nodes = State.graphData.nodes.filter(n => showTypes.has(n.type));
  const nodeIds = new Set(nodes.map(n => n.id));
  const links = State.graphData.edges.filter(e => showEdges.has(e.type) && nodeIds.has(e.source) && nodeIds.has(e.target));

  const svgEl = d3.select("#graph-svg").attr("width", W).attr("height", H);
  const g = svgEl.append("g");
  svgEl.call(d3.zoom().scaleExtent([0.2, 3]).on("zoom", e => g.attr("transform", e.transform)));

  const defs = svgEl.append("defs");
  [["prerequisite","#FF6B6B"],["applied_in","#4ECDC4"],["contains","#aab"]].forEach(([type, color]) => {
    defs.append("marker").attr("id",`arr-${type}`).attr("markerWidth",8).attr("markerHeight",8)
      .attr("refX",20).attr("refY",3).attr("orient","auto")
      .append("path").attr("d","M0,0 L0,6 L8,3 z").attr("fill",color);
  });

  const link = g.append("g").selectAll("line").data(links).enter().append("line")
    .attr("stroke", d => d.color || "#aab").attr("stroke-width", 1.5).attr("opacity", .5)
    .attr("stroke-dasharray", d => d.dashed ? "5 3" : null)
    .attr("marker-end", d => `url(#arr-${d.type})`);

  const node = g.append("g").selectAll("g").data(nodes).enter().append("g").attr("class","graph-node")
    .call(d3.drag()
      .on("start", (e,d) => { if (!e.active) sim.alphaTarget(.3).restart(); d.fx=d.x; d.fy=d.y; })
      .on("drag",  (e,d) => { d.fx=e.x; d.fy=e.y; })
      .on("end",   (e,d) => { if (!e.active) sim.alphaTarget(0); d.fx=null; d.fy=null; })
    );

  node.append("circle")
    .attr("r", d => d.size).attr("fill", d => d.color + (d.type==="part"?"dd":"88"))
    .attr("stroke", d => d.color).attr("stroke-width", 2)
    .on("click", (e,d) => { SFX.play("nav"); selectGraphNode(d); })
    .on("mouseover", (e,d) => { const tip=document.getElementById("graph-tooltip"); tip.classList.remove("hidden"); tip.textContent=d.label; moveTooltip(e); })
    .on("mousemove", e => moveTooltip(e))
    .on("mouseout", () => document.getElementById("graph-tooltip").classList.add("hidden"));

  node.append("text").attr("dy", d => d.size + 13).text(d => d.label)
    .style("font-size", d => d.type==="part"?"12px":"10px")
    .style("font-weight", d => d.type==="part"?"700":"400");

  const sim = d3.forceSimulation(nodes)
    .force("link",      d3.forceLink(links).id(d=>d.id).distance(d=>d.type==="contains"?85:160).strength(.5))
    .force("charge",    d3.forceManyBody().strength(-280))
    .force("center",    d3.forceCenter(W/2, H/2))
    .force("collision", d3.forceCollide().radius(d=>d.size+10))
    .on("tick", () => {
      link.attr("x1",d=>d.source.x).attr("y1",d=>d.source.y).attr("x2",d=>d.target.x).attr("y2",d=>d.target.y);
      node.attr("transform",d=>`translate(${d.x},${d.y})`);
    });
}

function moveTooltip(e) {
  const rect = document.getElementById("graph-svg-wrap").getBoundingClientRect();
  const tip  = document.getElementById("graph-tooltip");
  tip.style.left = (e.clientX - rect.left + 12) + "px";
  tip.style.top  = (e.clientY - rect.top  - 10) + "px";
}

function selectGraphNode(d) {
  State.selectedGraphNode = d;
  const detail = document.getElementById("graph-detail");
  detail.classList.remove("hidden");
  document.getElementById("graph-detail-title").textContent    = d.label;
  document.getElementById("graph-detail-keywords").textContent = d.keywords ? `키워드: ${d.keywords.join(", ")}` : (d.type==="part"?"편(Part)":"");
  document.getElementById("btn-graph-goto-chapter").style.display = d.type==="chapter" ? "" : "none";
}

/* ===== 챕터 추가 모달 ===== */
function setupModal() {
  const modal = document.getElementById("modal-add-chapter");
  document.getElementById("btn-add-chapter").addEventListener("click", () => {
    const sel = document.getElementById("new-ch-part");
    sel.innerHTML = State.parts.map(p=>`<option value="${p.id}">${p.title}</option>`).join("");
    modal.classList.remove("hidden");
  });
  modal.querySelectorAll(".modal-close").forEach(btn => btn.addEventListener("click", () => modal.classList.add("hidden")));
  modal.addEventListener("click", e => { if (e.target===modal) modal.classList.add("hidden"); });

  document.getElementById("btn-save-chapter").addEventListener("click", async () => {
    const newCh = {
      id:       document.getElementById("new-ch-id").value.trim(),
      title:    document.getElementById("new-ch-title").value.trim(),
      partId:   document.getElementById("new-ch-part").value,
      startPage:   parseInt(document.getElementById("new-ch-start").value) || 1,
      endPage:     parseInt(document.getElementById("new-ch-end").value)   || 10,
      pdfStartPage:(parseInt(document.getElementById("new-ch-start").value)||1)-1,
      keywords: document.getElementById("new-ch-keywords").value.split(",").map(k=>k.trim()).filter(Boolean),
      check: [],
    };
    const part = State.parts.find(p => p.id === newCh.partId);
    if (part) { newCh.partTitle = part.title; newCh.partColor = part.color; }
    if (!newCh.id || !newCh.title) { alert("ID와 제목은 필수입니다."); return; }
    const res = await fetch("/api/chapters", {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(newCh)
    });
    if (res.ok) {
      State.chapters.push(newCh);
      renderSidebar();
      modal.classList.add("hidden");
      SFX.play("success");
    } else {
      alert((await res.json()).error || "저장 실패");
    }
  });
}

/* ===== 유틸 ===== */

function cleanText(str) {
  return String(str || "")
    .replace(/[■□▪▫●○◆◇►◄▶◀]+/g, "")
    .replace(/\s{2,}/g, " ").trim();
}

function escHtml(str) {
  return String(str||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function shuffle(arr) {
  for (let i=arr.length-1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]] = [arr[j],arr[i]];
  }
  return arr;
}

// Service Worker — page images cached persistently in browser
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
