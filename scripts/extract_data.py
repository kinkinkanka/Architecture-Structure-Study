"""
PDF에서 챕터별 텍스트, 핵심문제, 개념 데이터를 추출하여 JSON으로 저장
"""
import fitz
import json
import re
import sys
sys.stdout.reconfigure(encoding='utf-8')

PDF_PATH = r"g:\내 드라이브\Main\2026\건축기사\실기\구조\건축기사 구조_ocr.pdf"
OUTPUT_DIR = r"g:\내 드라이브\Main\2026\건축기사\실기\구조\study-website\static\data"

# 챕터 구조 정의 (페이지는 0-indexed)
CHAPTER_STRUCTURE = {
    "parts": [
        {
            "id": "part1",
            "title": "구조역학",
            "color": "#4A90D9",
            "chapters": [
                {"id": "ch1-1", "title": "힘의 합성과 회전", "start_page": 11, "end_page": 21,
                 "check": ["작용점이 같은 두 힘의 합력", "모멘트의 정의", "우력의 특징", "바리뇽의 정리", "라미의 정리"],
                 "keywords": ["합력", "모멘트", "우력", "바리뇽", "라미", "sin법칙", "벡터", "스칼라"]},
                {"id": "ch1-2", "title": "힘의 평형", "start_page": 21, "end_page": 31,
                 "check": ["평형 3조건", "보의 부정정 차수", "라멘의 부정정 차수", "트러스의 부정정 차수"],
                 "keywords": ["평형조건", "부정정차수", "이동지점", "회전지점", "고정지점", "정정구조", "부정정구조"]},
                {"id": "ch1-3", "title": "지점반력", "start_page": 31, "end_page": 43,
                 "check": ["단순보 반력계산", "캔틸레버 반력계산", "겔버보 반력계산", "3-Hinge 아치 반력"],
                 "keywords": ["반력", "단순보", "캔틸레버", "내민보", "겔버보", "아치", "중첩의 원리"]},
                {"id": "ch1-4", "title": "전단력·휨모멘트", "start_page": 43, "end_page": 73,
                 "check": ["부호규약", "축방향력", "전단력도", "휨모멘트도", "절대최대휨모멘트"],
                 "keywords": ["전단력", "휨모멘트", "SFD", "BMD", "부재력", "내력", "절대최대"]},
                {"id": "ch1-5", "title": "트러스 구조해석", "start_page": 73, "end_page": 87,
                 "check": ["절점법", "절단법", "Zero Force Member"],
                 "keywords": ["트러스", "절점법", "절단법", "영부재", "축방향력"]},
                {"id": "ch1-6", "title": "단면의 성질", "start_page": 87, "end_page": 105,
                 "check": ["단면1차모멘트", "단면2차모멘트", "단면계수", "단면2차반경"],
                 "keywords": ["단면1차모멘트", "단면2차모멘트", "단면계수", "도심", "중립축"]},
                {"id": "ch1-7", "title": "응력과 변형률", "start_page": 105, "end_page": 128,
                 "check": ["응력의 종류", "변형률", "후크의 법칙", "포아송비"],
                 "keywords": ["응력", "변형률", "후크의법칙", "탄성계수", "포아송비", "전단응력"]},
                {"id": "ch1-8", "title": "보의 휨변형", "start_page": 128, "end_page": 147,
                 "check": ["처짐각", "처짐", "공액보법"],
                 "keywords": ["처짐", "처짐각", "공액보법", "탄성곡선", "변형"]},
                {"id": "ch1-9", "title": "기둥", "start_page": 147, "end_page": 165,
                 "check": ["편심축하중 단주", "단면의 핵", "장주"],
                 "keywords": ["기둥", "편심", "핵", "장주", "좌굴", "오일러"]},
                {"id": "ch1-10", "title": "부정정구조", "start_page": 165, "end_page": 185,
                 "check": ["변위일치법", "처짐각법", "모멘트분배법"],
                 "keywords": ["부정정", "변위일치법", "처짐각법", "모멘트분배법", "고정단모멘트", "분배율"]},
            ]
        },
        {
            "id": "part2",
            "title": "철근콘크리트구조",
            "color": "#E8644A",
            "chapters": [
                {"id": "ch2-1", "title": "RC 해석과 설계의 원칙", "start_page": 187, "end_page": 210,
                 "check": ["하중계수", "하중조합", "강도감소계수", "극한강도설계법"],
                 "keywords": ["강도설계법", "하중계수", "강도감소계수", "소요강도", "설계강도", "공칭강도"]},
                {"id": "ch2-2", "title": "RC구조해석 일반사항", "start_page": 201, "end_page": 237,
                 "check": ["탄성계수비", "경량콘크리트계수", "T형보 유효폭", "기둥 철근비"],
                 "keywords": ["탄성계수", "탄성계수비", "T형보", "유효폭", "철근비", "띠철근", "나선철근"]},
                {"id": "ch2-3", "title": "RC 단철근 보 해석", "start_page": 215, "end_page": 257,
                 "check": ["등가응력블록", "균형철근비", "공칭휨강도"],
                 "keywords": ["단철근", "등가응력블록", "균형철근비", "인장지배", "압축지배", "공칭휨강도"]},
                {"id": "ch2-4", "title": "RC 전단설계", "start_page": 237, "end_page": 269,
                 "check": ["콘크리트 전단강도", "스터럽 간격", "최소전단철근"],
                 "keywords": ["전단강도", "스터럽", "전단철근", "사인장균열", "복부보강"]},
                {"id": "ch2-5", "title": "RC 슬래브", "start_page": 249, "end_page": 281,
                 "check": ["1방향 슬래브", "2방향 슬래브", "슬래브 두께"],
                 "keywords": ["슬래브", "1방향", "2방향", "철근간격", "최소두께"]},
                {"id": "ch2-6", "title": "RC구조 사용성", "start_page": 263, "end_page": 287,
                 "check": ["처짐 제한", "균열폭 제한", "내구성"],
                 "keywords": ["사용성", "처짐제한", "균열", "내구성", "피복두께"]},
                {"id": "ch2-7", "title": "RC구조 철근 상세", "start_page": 275, "end_page": 293,
                 "check": ["정착길이", "이음길이", "갈고리"],
                 "keywords": ["정착길이", "이음", "갈고리", "부착", "피복두께", "철근간격"]},
            ]
        },
        {
            "id": "part3",
            "title": "강구조",
            "color": "#5DBB63",
            "chapters": [
                {"id": "ch3-1", "title": "강구조 일반사항", "start_page": 291, "end_page": 307,
                 "check": ["강재의 종류", "허용응력설계법", "한계상태설계법"],
                 "keywords": ["강재", "SS400", "SM", "허용응력", "항복강도", "인장강도"]},
                {"id": "ch3-2", "title": "강구조 접합(I) - 볼트", "start_page": 301, "end_page": 323,
                 "check": ["고장력볼트", "볼트 설계강도", "순단면적"],
                 "keywords": ["고장력볼트", "마찰접합", "지압접합", "볼트강도", "순단면"]},
                {"id": "ch3-3", "title": "강구조 접합(II) - 용접", "start_page": 309, "end_page": 341,
                 "check": ["맞댐용접", "필릿용접", "유효목두께"],
                 "keywords": ["용접", "맞댐", "필릿", "유효목두께", "용접강도"]},
                {"id": "ch3-4", "title": "강구조 부재 설계", "start_page": 327, "end_page": 345,
                 "check": ["인장재", "압축재", "보 설계", "세장비"],
                 "keywords": ["인장재", "압축재", "좌굴", "세장비", "유효좌굴길이", "판좌굴"]},
            ]
        },
        {
            "id": "part4",
            "title": "건축구조 일반사항",
            "color": "#9B59B6",
            "chapters": [
                {"id": "ch4-1", "title": "구조시스템", "start_page": 345, "end_page": 365,
                 "check": ["라멘구조", "전단벽구조", "트러스구조", "아치구조"],
                 "keywords": ["구조시스템", "라멘", "전단벽", "내력벽", "코어", "아웃리거"]},
                {"id": "ch4-2", "title": "토질 및 기초", "start_page": 357, "end_page": 381,
                 "check": ["지반의 종류", "기초의 종류", "지지력"],
                 "keywords": ["토질", "기초", "독립기초", "복합기초", "지지력", "침하", "말뚝"]},
                {"id": "ch4-3", "title": "내진 설계", "start_page": 371, "end_page": 393,
                 "check": ["내진등급", "지진하중", "반응수정계수", "밑면전단력"],
                 "keywords": ["내진", "지진하중", "반응수정계수", "밑면전단력", "층간변위", "중요도계수"]},
            ]
        }
    ]
}

def clean_text(text):
    """OCR 텍스트 정제"""
    # 불필요한 공백 정리
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = re.sub(r' {3,}', ' ', text)
    return text.strip()

def extract_page_range(doc, start, end):
    """페이지 범위 텍스트 추출"""
    texts = []
    for i in range(start, min(end, doc.page_count)):
        page = doc[i]
        text = page.get_text()
        if text.strip():
            texts.append(clean_text(text))
    return "\n\n---\n\n".join(texts)

def extract_problems(text):
    """핵심문제 추출 (번호. 형태로 시작하는 문제)"""
    problems = []

    # 핵심예제 패턴
    example_pattern = re.compile(
        r'핵심예제\s*(\d+).*?(?=핵심예제\s*\d+|핵심문제|■|$)',
        re.DOTALL
    )
    # 번호형 문제 패턴 (1. 2. 3. ...)
    prob_pattern = re.compile(
        r'(?:^|\n)(\d+)\.\s+(.{20,}?)(?=\n\d+\.\s|\n해답|\Z)',
        re.DOTALL | re.MULTILINE
    )

    for m in prob_pattern.finditer(text):
        num = m.group(1)
        content = m.group(2).strip()
        # 해설 분리
        answer_match = re.search(r'해[절젤]\s*["\]!]?\s*(.*)', content, re.DOTALL)
        if answer_match:
            question = content[:answer_match.start()].strip()
            answer = answer_match.group(1).strip()
        else:
            question = content[:200].strip()
            answer = ""

        if len(question) > 15:
            problems.append({
                "num": int(num),
                "question": question[:400],
                "answer": answer[:300],
                "options": extract_options(question)
            })

    return problems

def extract_options(text):
    """선택지 추출 ① ② ③ ④"""
    options = []
    pattern = re.compile(r'[①②③④⑤]\s*(.+?)(?=[①②③④⑤]|$)', re.DOTALL)
    for m in pattern.finditer(text):
        opt = m.group(1).strip().replace('\n', ' ')
        if opt and len(opt) < 100:
            options.append(opt)
    return options[:4]

def build_chapters_json(doc):
    """chapters.json 생성"""
    chapters_data = []
    for part in CHAPTER_STRUCTURE["parts"]:
        for ch in part["chapters"]:
            text = extract_page_range(doc, ch["start_page"], ch["end_page"])
            chapters_data.append({
                "id": ch["id"],
                "partId": part["id"],
                "partTitle": part["title"],
                "partColor": part["color"],
                "title": ch["title"],
                "startPage": ch["start_page"] + 1,  # 1-indexed for display
                "endPage": ch["end_page"],
                "pdfStartPage": ch["start_page"],
                "check": ch["check"],
                "keywords": ch["keywords"],
                "summary": text[:600] if text else "",
            })
    return chapters_data

def build_problems_json(doc):
    """problems.json 생성 - 챕터별 문제 목록"""
    all_problems = []
    for part in CHAPTER_STRUCTURE["parts"]:
        for ch in part["chapters"]:
            text = extract_page_range(doc, ch["start_page"], ch["end_page"])
            probs = extract_problems(text)
            for p in probs:
                p["chapterId"] = ch["id"]
                p["chapterTitle"] = ch["title"]
                p["partTitle"] = part["title"]
                p["partColor"] = part["color"]
                all_problems.append(p)
    return all_problems

def build_graph_json():
    """graph.json 생성 - 개념 관계 그래프"""
    nodes = []
    edges = []

    # Part 노드
    for part in CHAPTER_STRUCTURE["parts"]:
        nodes.append({
            "id": part["id"],
            "label": part["title"],
            "type": "part",
            "color": part["color"],
            "size": 28
        })

    # Chapter 노드
    for part in CHAPTER_STRUCTURE["parts"]:
        for ch in part["chapters"]:
            nodes.append({
                "id": ch["id"],
                "label": ch["title"],
                "type": "chapter",
                "color": part["color"],
                "partId": part["id"],
                "size": 18,
                "keywords": ch["keywords"]
            })
            # Part → Chapter 엣지
            edges.append({
                "source": part["id"],
                "target": ch["id"],
                "type": "contains",
                "strength": 0.8
            })

    # 선수 관계 (prerequisite) 엣지
    prereqs = [
        ("ch1-1", "ch1-2", "prerequisite"),
        ("ch1-2", "ch1-3", "prerequisite"),
        ("ch1-3", "ch1-4", "prerequisite"),
        ("ch1-4", "ch1-5", "prerequisite"),
        ("ch1-2", "ch1-5", "prerequisite"),
        ("ch1-6", "ch1-7", "prerequisite"),
        ("ch1-7", "ch1-8", "prerequisite"),
        ("ch1-4", "ch1-8", "prerequisite"),
        ("ch1-8", "ch1-10", "prerequisite"),
        ("ch1-7", "ch1-9", "prerequisite"),
        # 구조역학 → RC
        ("ch1-3", "ch2-1", "applied_in"),
        ("ch1-4", "ch2-3", "applied_in"),
        ("ch1-6", "ch2-3", "applied_in"),
        ("ch1-7", "ch2-1", "applied_in"),
        ("ch1-7", "ch2-4", "applied_in"),
        ("ch1-8", "ch2-6", "applied_in"),
        ("ch1-9", "ch2-2", "applied_in"),
        # RC 내부
        ("ch2-1", "ch2-2", "prerequisite"),
        ("ch2-2", "ch2-3", "prerequisite"),
        ("ch2-3", "ch2-4", "prerequisite"),
        ("ch2-3", "ch2-5", "prerequisite"),
        ("ch2-3", "ch2-6", "applied_in"),
        ("ch2-3", "ch2-7", "prerequisite"),
        # 구조역학 → 강구조
        ("ch1-7", "ch3-1", "applied_in"),
        ("ch1-6", "ch3-4", "applied_in"),
        ("ch1-9", "ch3-4", "applied_in"),
        # 강구조 내부
        ("ch3-1", "ch3-2", "prerequisite"),
        ("ch3-1", "ch3-3", "prerequisite"),
        ("ch3-2", "ch3-4", "prerequisite"),
        ("ch3-3", "ch3-4", "prerequisite"),
        # 일반사항
        ("ch2-1", "ch4-1", "applied_in"),
        ("ch4-2", "ch4-3", "prerequisite"),
        ("ch1-3", "ch4-2", "applied_in"),
    ]

    edge_type_meta = {
        "prerequisite": {"color": "#FF6B6B", "label": "선수과목", "dashed": False},
        "applied_in": {"color": "#4ECDC4", "label": "응용", "dashed": True},
        "contains": {"color": "#95A5A6", "label": "포함", "dashed": False},
    }

    for src, tgt, etype in prereqs:
        edges.append({
            "source": src,
            "target": tgt,
            "type": etype,
            **edge_type_meta[etype]
        })

    return {
        "nodes": nodes,
        "edges": edges,
        "edgeTypes": edge_type_meta
    }

def main():
    print("PDF 열기...")
    doc = fitz.open(PDF_PATH)
    print(f"총 {doc.page_count} 페이지")

    print("챕터 데이터 추출 중...")
    chapters = build_chapters_json(doc)
    with open(f"{OUTPUT_DIR}/chapters.json", "w", encoding="utf-8") as f:
        json.dump({"parts": CHAPTER_STRUCTURE["parts"], "chapters": chapters}, f, ensure_ascii=False, indent=2)
    print(f"  → chapters.json 저장 ({len(chapters)} 챕터)")

    print("문제 데이터 추출 중...")
    problems = build_problems_json(doc)
    with open(f"{OUTPUT_DIR}/problems.json", "w", encoding="utf-8") as f:
        json.dump({"problems": problems, "total": len(problems)}, f, ensure_ascii=False, indent=2)
    print(f"  → problems.json 저장 ({len(problems)} 문제)")

    print("그래프 데이터 생성 중...")
    graph = build_graph_json()
    with open(f"{OUTPUT_DIR}/graph.json", "w", encoding="utf-8") as f:
        json.dump(graph, f, ensure_ascii=False, indent=2)
    print(f"  → graph.json 저장 ({len(graph['nodes'])} 노드, {len(graph['edges'])} 엣지)")

    doc.close()
    print("\n완료!")

if __name__ == "__main__":
    main()
