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


def _ssl_context():
    """맥에 python.org 파이썬을 깔면 인증서가 비어 있는 경우가 있어, 시스템 인증서를 대신 씀"""
    import ssl
    ctx = ssl.create_default_context()
    if not ctx.get_ca_certs():
        for path in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
            if os.path.exists(path):
                ctx.load_verify_locations(path)
                break
    return ctx


SSL_CTX = _ssl_context()
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
    with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as r:
        body = r.read()
    return body if raw else json.loads(body)


def data_go(path, params):
    """공공데이터 API 호출 → item 목록(dict)"""
    qs = urllib.parse.urlencode({"serviceKey": DATA_KEY, **params})
    try:
        with urllib.request.urlopen(f"{NMC}/{path}?{qs}", timeout=15, context=SSL_CTX) as r:
            root = ET.fromstring(r.read())
    except urllib.error.HTTPError as e:   # 키 오류도 XML로 옴 → 이유를 읽어서 알려 줌 (키는 남기지 않음)
        try:
            root = ET.fromstring(e.read())
        except ET.ParseError:
            raise RuntimeError(f"공공데이터 HTTP {e.code}") from None
    code = root.findtext(".//resultCode") or root.findtext(".//returnReasonCode")
    if code not in (None, "00", "0000"):
        raise RuntimeError(f"공공데이터 오류 {code}: {root.findtext('.//resultMsg') or root.findtext('.//returnAuthMsg') or ''}")
    return [{c.tag: (c.text or "").strip() for c in it} for it in root.iter("item")]


GBIS = "https://apis.data.go.kr/6410000"


def bus_arrival(station_id, route_id=None):
    """경기도 버스도착정보 v2 → 노선별 도착 예정 (분, 몇 정거장 전, 저상버스, 혼잡)"""
    qs = urllib.parse.urlencode({"serviceKey": DATA_KEY, "stationId": station_id, "format": "json"})
    with urllib.request.urlopen(f"{GBIS}/busarrivalservice/v2/getBusArrivalListv2?{qs}", timeout=15, context=SSL_CTX) as r:
        j = json.loads(r.read())
    head = j.get("response", {}).get("msgHeader", {})
    if str(head.get("resultCode")) not in ("0", "4"):   # 4 = 도착 정보 없음
        raise RuntimeError(f"버스정보 오류 {head.get('resultCode')}: {head.get('resultMessage', '')}")
    rows = (j["response"].get("msgBody") or {}).get("busArrivalList") or []
    if isinstance(rows, dict):
        rows = [rows]
    out = []
    for b in rows:
        if route_id and str(b.get("routeId")) != str(route_id):
            continue
        buses = []
        for n in ("1", "2"):
            t = b.get("predictTime" + n)
            if t not in ("", None):
                buses.append({"min": int(t), "stops": b.get("locationNo" + n) or None,
                              "low": b.get("lowPlate" + n) == 1, "crowded": b.get("crowded" + n) or 0,
                              "stationNow": b.get("stationNm" + n) or ""})
        out.append({"routeId": b.get("routeId"), "routeName": str(b.get("routeName")),
                    "dest": b.get("routeDestName", ""), "flag": b.get("flag", ""), "buses": buses})
    return out


def bus_stops(lat, lng):
    """경기도 버스정보: 좌표 주변 정류장"""
    qs = urllib.parse.urlencode({"serviceKey": DATA_KEY, "x": f"{lng:.6f}", "y": f"{lat:.6f}", "format": "json"})
    with urllib.request.urlopen(f"{GBIS}/busstationservice/v2/getBusStationAroundListv2?{qs}", timeout=15, context=SSL_CTX) as r:
        j = json.loads(r.read())
    rows = (j.get("response", {}).get("msgBody") or {}).get("busStationAroundList") or []
    if isinstance(rows, dict):
        rows = [rows]
    return [{"id": x.get("stationId"), "name": x.get("stationName"), "no": str(x.get("mobileNo") or "").strip(),
             "lat": float(x.get("y")), "lng": float(x.get("x")), "d": x.get("distance")} for x in rows]


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
            return self._json(200, {"ai": bool(KEY), "tts": bool(KEY), "data": bool(DATA_KEY), "bus": bool(DATA_KEY)})
        if self.path.startswith("/api/near"):
            return self.near()
        if self.path.startswith("/api/stops"):
            if not DATA_KEY:
                return self._json(503, {"error": "DATA_GO_KR_KEY 없음"})
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                return self._json(200, {"items": bus_stops(float(q["lat"][0]), float(q["lng"][0]))})
            except (KeyError, ValueError):
                return self._json(400, {"error": "lat, lng 필요"})
            except Exception as e:  # noqa: BLE001
                return self._json(502, {"error": str(e)[:200]})
        if self.path.startswith("/api/bus"):
            if not DATA_KEY:
                return self._json(503, {"error": "DATA_GO_KR_KEY 없음"})
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            sid = q.get("stationId", [""])[0]
            if not sid.isdigit():
                return self._json(400, {"error": "stationId 필요"})
            rid = q.get("routeId", [""])[0] or None
            try:
                return self._json(200, {"items": bus_arrival(sid, rid)})
            except Exception as e:  # noqa: BLE001
                return self._json(502, {"error": str(e)[:200]})
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
            body = json.loads(self.rfile.read(min(n, 4_000_000)) or b"{}")
            text = str(body.get("text", ""))[:8000]
            if not text and self.path != "/api/vision":
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

            if self.path == "/api/vision":
                img = str(body.get("image", ""))
                if not img.startswith("data:image/") or len(img) > 3_000_000:
                    return self._json(400, {"error": "image 필요"})
                ctx = str(body.get("context", ""))[:200]
                res = openai("chat/completions", {
                    "model": "gpt-4o-mini", "temperature": 0, "response_format": {"type": "json_object"},
                    "messages": [
                        {"role": "system", "content": "너는 길을 잃은 어르신을 돕는 도우미야. 사진 속 표지판·간판 글자를 읽고, "
                         "어디인지와 지금 할 일 한 가지를 쉬운 존댓말 두 문장 이내로 알려 줘. 보이지 않는 것은 지어내지 마. "
                         'JSON으로만: {"answer": 안내 문장, "text": 사진에서 읽은 글자}'},
                        {"role": "user", "content": [
                            {"type": "text", "text": f"상황: {ctx or '병원 가는 길'}"},
                            {"type": "image_url", "image_url": {"url": img, "detail": "low"}}]}]})
                out = json.loads(res["choices"][0]["message"]["content"])
                return self._json(200, {"answer": str(out.get("answer", ""))[:300], "text": str(out.get("text", ""))[:500]})

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
