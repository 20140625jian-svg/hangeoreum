// 병원한걸음 공공데이터 중계 서버 (Cloudflare Workers, 무료)
// 공공데이터 인증키를 숨겨 두고, 휴대폰 웹앱이 가까운 병원·응급실을 물어볼 수 있게 해 줍니다.
//
// 올리는 법:
//   npx wrangler login
//   npx wrangler deploy worker.js --name hangeoreum-api --compatibility-date 2026-11-01
//   npx wrangler secret put DATA_GO_KR_KEY --name hangeoreum-api     (← 여기서 키 붙여넣기)
// 그다음 config.js 의 apiBase 에 나온 주소(https://hangeoreum-api.<계정>.workers.dev)를 넣으세요.

const NMC = "https://apis.data.go.kr/B552657";
const ALLOW_ORIGIN = "https://20140625jian-svg.github.io";

function items(xml) {
  const code = (xml.match(/<resultCode>([^<]*)</) || [])[1];
  if (code && code !== "00" && code !== "0000") throw new Error("공공데이터 오류 " + code);
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const o = {};
    for (const f of m[1].matchAll(/<(\w+)>([^<]*)<\/\1>/g)) o[f[1]] = f[2].trim();
    return o;
  });
}
async function dataGo(env, path, params) {
  const key = decodeURIComponent(env.DATA_GO_KR_KEY || "");
  const qs = new URLSearchParams({ serviceKey: key, ...params });
  const r = await fetch(`${NMC}/${path}?${qs}`);
  return items(await r.text());
}
const hhmm = v => /^\d{4}$/.test(v || "") ? v.slice(0, 2) + ":" + v.slice(2) : "";

async function near(env, kind, lat, lng) {
  const op = kind === "er" ? "ErmctInfoInqireService/getEgytLcinfoInqire" : "HsptlAsembySearchService/getHsptlMdcncLcinfoInqire";
  const out = (await dataGo(env, op, { WGS84_LON: lng, WGS84_LAT: lat, pageNo: 1, numOfRows: 15 }))
    .filter(it => it.latitude && it.longitude)
    .map(it => ({
      id: it.hpid || "", name: it.dutyName || "", addr: it.dutyAddr || "", tel: it.dutyTel1 || "",
      kind: it.dutyDivName || "", lat: +it.latitude, lng: +it.longitude,
      open: hhmm(it.startTime), close: hhmm(it.endTime), er: kind === "er"
    }));
  if (kind === "er" && out.length) {
    try {
      const [s1, s2] = out[0].addr.split(/\s+/);
      const beds = await dataGo(env, "ErmctInfoInqireService/getEmrrmRltmUsefulSckbdInfoInqire", { STAGE1: s1, STAGE2: s2, pageNo: 1, numOfRows: 50 });
      const by = Object.fromEntries(beds.map(b => [b.hpid, b]));
      for (const h of out) {
        const b = by[h.id];
        if (b && /^-?\d+$/.test(b.hvec || "")) {
          h.beds = Math.max(0, +b.hvec);
          const t = b.hvidate || "";
          h.bedsAt = t.length >= 12 ? `${t.slice(8, 10)}:${t.slice(10, 12)} 기준` : "";
          if (b.dutyTel3) h.erTel = b.dutyTel3;
        }
      }
    } catch { /* 빈 침대 정보는 없어도 됨 */ }
  }
  return out;
}

export default {
  async fetch(req, env) {
    const cors = { "Access-Control-Allow-Origin": ALLOW_ORIGIN, "Content-Type": "application/json; charset=utf-8" };
    const u = new URL(req.url);
    if (u.pathname === "/api/health") return new Response(JSON.stringify({ data: !!env.DATA_GO_KR_KEY }), { headers: cors });
    if (u.pathname !== "/api/near") return new Response("{}", { status: 404, headers: cors });
    const lat = +u.searchParams.get("lat"), lng = +u.searchParams.get("lng");
    if (!isFinite(lat) || !isFinite(lng)) return new Response('{"error":"lat, lng 필요"}', { status: 400, headers: cors });
    try {
      const list = await near(env, u.searchParams.get("type") === "er" ? "er" : "hosp", lat.toFixed(5), lng.toFixed(5));
      return new Response(JSON.stringify({ items: list }), { headers: { ...cors, "Cache-Control": "max-age=60" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e).slice(0, 200) }), { status: 502, headers: cors });
    }
  }
};
