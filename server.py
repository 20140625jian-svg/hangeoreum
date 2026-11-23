"""병원한걸음 중계 서버 (설치할 라이브러리 없음, 파이썬 기본 기능만 사용)

- 웹앱 파일(index.html 등)을 보여 줍니다.
- OPENAI_API_KEY 가 있으면:
    /api/parse : 어르신 말 → 병원 · 첫 방문 · 이동 도움 · 접수 도움 4가지로 정리 (GPT-4o-mini)
    /api/tts   : 안내 문장 → 따뜻하고 자연스러운 AI 목소리(mp3)
- 키가 없으면 웹앱이 기기 안 규칙 해석 + 기기 내장 목소리로 알아서 동작합니다.

실행:
    export OPENAI_API_KEY=sk-...     # (선택)
    python3 server.py                # http://localhost:8000
"""
import json
import os
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))


def load_env():
    """같은 폴더의 .env 파일(KEY=값)을 환경변수로 읽기. 이 파일은 GitHub에 올라가지 않습니다."""
    path = os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        return
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()
KEY = os.environ.get("OPENAI_API_KEY", "").strip()
# 공공데이터포털 인증키 (Encoding 키를 넣어도 자동으로 풀어서 씀)
DATA_KEY = urllib.parse.unquote(os.environ.get("DATA_GO_KR_KEY", "").strip())
NMC = "https://apis.data.go.kr/B552657"
PORT = int(os.environ.get("PORT", "8000"))
TTS_VOICE = os.environ.get("TTS_VOICE", "coral")

PARSE_PROMPT = """너는 병원에 혼자 가는 어르신의 말을 정리하는 도우미야.
어르신 말에서 아래 4가지만 뽑아 JSON으로만 답해. 말에 없으면 null.
- hospital: 병원 이름 (예: "분당서울대학교병원". '분당서울대', '서울대병원'도 이것으로)
- firstVisit: 이 병원에 처음 가면 true, 가 본 적 있으면 false
- mobility: "보행기" | "휠체어" | "지팡이" | "걷기 힘듦" | "도움 필요 없음"
- reception: 병원 접수·수납을 도와줄 사람이 필요하면 true, 혼자 한다면 false
추측하지 말고, 확실하지 않으면 null로 둬. 다른 설명은 쓰지 마."""

SUMMARY_PROMPT = """너는 진료실에서 의사 선생님 말씀을 받아 적은 글을 어르신이 알아듣기 쉽게 정리하는 도우미야.
규칙:
- 받아 적은 글에 있는 내용만 쓰고, 없는 약 이름·용량·날짜·진단은 절대 지어내지 마.
- 초등학생도 알아듣는 짧은 존댓말 문장으로. 어려운 의학 용어는 쉬운 말로 풀고 괄호에 원래 말을 남겨.
- 약 이름, 숫자, 횟수, 시간(아침/식후 등), 날짜는 그대로 정확히.
- 음성 인식 오류로 보이는 부분은 추측해서 고치지 말고 빼.
JSON으로만 답해: {"oneLine": 한 문장 요약, "diagnosis": [몸 상태], "medicine": [약 먹는 법], "nextVisit": [다음 진료], "tests": [검사], "caution": [조심할 것], "other": [기타]}
각 배열은 없으면 빈 배열."""

TTS_STYLE = ("천천히, 또박또박, 따뜻하고 다정한 말투로 어르신께 길을 알려 주듯 한국어로 말하세요. "
             "문장 사이에 살짝 쉬고, 숫자와 버스 번호는 분명하게 읽으세요.")


def openai(path, payload, raw=False):
    req = urllib.request.Request(
        "https://api.openai.com/v1/" + path,
        data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read()
    return body if raw else json.loads(body)


def data_go(path, params):
    """공공데이터 API 호출 → item 목록(dict)"""
    qs = urllib.parse.urlencode({"serviceKey": DATA_KEY, **params})
    with urllib.request.urlopen(f"{NMC}/{path}?{qs}", timeout=15) as r:
        root = ET.fromstring(r.read())
    code = root.findtext(".//resultCode") or root.findtext(".//returnReasonCode")
    if code not in (None, "00", "0000"):
        raise RuntimeError(f"공공데이터 오류 {code}: {root.findtext('.//resultMsg') or root.findtext('.//returnAuthMsg') or ''}")
    return [{c.tag: (c.text or "").strip() for c in it} for it in root.iter("item")]


def hhmm(v):
    return f"{v[:2]}:{v[2:]}" if v and len(v) == 4 and v.isdigit() else ""


def near_hospitals(kind, lat, lng):
    op = "ErmctInfoInqireService/getEgytLcinfoInqire" if kind == "er" else "HsptlAsembySearchService/getHsptlMdcncLcinfoInqire"
    items = data_go(op, {"WGS84_LON": lng, "WGS84_LAT": lat, "pageNo": 1, "numOfRows": 15})
    out = []
    for it in items:
        try:
            out.append({
                "id": it.get("hpid", ""), "name": it.get("dutyName", ""), "addr": it.get("dutyAddr", ""),
                "tel": it.get("dutyTel1", ""), "kind": it.get("dutyDivName", ""),
                "lat": float(it["latitude"]), "lng": float(it["longitude"]),
                "open": hhmm(it.get("startTime", "")), "close": hhmm(it.get("endTime", "")),
                "er": kind == "er",
            })
        except (KeyError, ValueError):
            continue
    if kind == "er" and out:
        # 응급실 실시간 빈 침대 (가능할 때만 붙임)
        try:
            parts = out[0]["addr"].split()
            beds = data_go("ErmctInfoInqireService/getEmrrmRltmUsefulSckbdInfoInqire",
                           {"STAGE1": parts[0], "STAGE2": parts[1], "pageNo": 1, "numOfRows": 50})
            by = {b.get("hpid"): b for b in beds}
            for h in out:
                b = by.get(h["id"])
                if b and b.get("hvec", "").lstrip("-").isdigit():
                    h["beds"] = max(0, int(b["hvec"]))
                    t = b.get("hvidate", "")
                    h["bedsAt"] = f"{t[8:10]}:{t[10:12]} 기준" if len(t) >= 12 else ""
                    if b.get("dutyTel3"):
                        h["erTel"] = b["dutyTel3"]
        except Exception:  # noqa: BLE001
            pass
    return out


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def _json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/health"):
            return self._json(200, {"ai": bool(KEY), "tts": bool(KEY), "data": bool(DATA_KEY)})
        if self.path.startswith("/api/near"):
            return self.near()
        if self.path.startswith(("/server.py", "/.env", "/worker.js")):
            return self.send_error(404)
        return super().do_GET()

    def near(self):
        if not DATA_KEY:
            return self._json(503, {"error": "DATA_GO_KR_KEY 없음"})
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        try:
            lat, lng = float(q["lat"][0]), float(q["lng"][0])
        except (KeyError, ValueError):
            return self._json(400, {"error": "lat, lng 필요"})
        kind = q.get("type", ["hosp"])[0]
        try:
            return self._json(200, {"items": near_hospitals(kind, lat, lng)})
        except Exception as e:  # noqa: BLE001
            return self._json(502, {"error": str(e)[:200]})

    def do_POST(self):
        if not KEY:
            return self._json(503, {"error": "OPENAI_API_KEY 없음"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(min(n, 10000)) or b"{}")
            text = str(body.get("text", ""))[:8000]
            if not text:
                return self._json(400, {"error": "text 없음"})

            if self.path == "/api/parse":
                res = openai("chat/completions", {
                    "model": "gpt-4o-mini",
                    "temperature": 0,
                    "response_format": {"type": "json_object"},
                    "messages": [{"role": "system", "content": PARSE_PROMPT},
                                 {"role": "user", "content": text}],
                })
                out = json.loads(res["choices"][0]["message"]["content"])
                # 응답 형식 검사: 4가지 항목만, 정해진 타입만 통과
                clean = {
                    "hospital": out.get("hospital") if isinstance(out.get("hospital"), str) else None,
                    "firstVisit": out.get("firstVisit") if isinstance(out.get("firstVisit"), bool) else None,
                    "mobility": out.get("mobility") if out.get("mobility") in
                    ("보행기", "휠체어", "지팡이", "걷기 힘듦", "도움 필요 없음") else None,
                    "reception": out.get("reception") if isinstance(out.get("reception"), bool) else None,
                }
                return self._json(200, clean)

            if self.path == "/api/summary":
                res = openai("chat/completions", {
                    "model": "gpt-4o-mini",
                    "temperature": 0,
                    "response_format": {"type": "json_object"},
                    "messages": [{"role": "system", "content": SUMMARY_PROMPT},
                                 {"role": "user", "content": text}],
                })
                out = json.loads(res["choices"][0]["message"]["content"])
                clean = {"oneLine": str(out.get("oneLine") or "")[:200]}
                for k in ("diagnosis", "medicine", "nextVisit", "tests", "caution", "other"):
                    v = out.get(k) or []
                    clean[k] = [str(x)[:300] for x in v if isinstance(x, (str, int, float))][:8] if isinstance(v, list) else []
                return self._json(200, clean)

            if self.path == "/api/tts":
                speed = float(body.get("speed", 0.92))
                audio = openai("audio/speech", {
                    "model": "gpt-4o-mini-tts",
                    "voice": TTS_VOICE,
                    "input": text,
                    "instructions": TTS_STYLE,
                    "speed": max(0.7, min(1.2, speed)),
                    "response_format": "mp3",
                }, raw=True)
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(len(audio)))
                self.end_headers()
                self.wfile.write(audio)
                return
            return self._json(404, {"error": "없는 주소"})
        except urllib.error.HTTPError as e:
            return self._json(502, {"error": f"OpenAI 오류 {e.code}"})
        except Exception as e:  # noqa: BLE001
            return self._json(500, {"error": str(e)[:200]})


if __name__ == "__main__":
    print(f"병원한걸음: http://localhost:{PORT}  (AI {'켜짐' if KEY else '꺼짐'} · 공공데이터 {'켜짐' if DATA_KEY else '꺼짐 — OpenStreetMap 사용'})")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
