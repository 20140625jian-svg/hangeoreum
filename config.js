// 공공데이터 중계 서버 주소 (Cloudflare Worker 등).
// 비워 두면: 같은 주소의 server.py 를 쓰고, 그것도 없으면 OpenStreetMap 무료 데이터를 씁니다.
// ⚠️ 여기에 공공데이터 키를 넣지 마세요. 키는 중계 서버에만 넣습니다.
window.HG_CONFIG = {
  apiBase: ""   // 예: "https://hangeoreum-api.<계정>.workers.dev"
};
