/* 병원한걸음 — 혼자 병원 가는 어르신을 위한 한 걸음 음성 길안내 웹앱
 *  화면 1: 방문 조건 말하기 + AI 정리/확인 → 성남시 병원동행 신청 안내
 *  화면 2: 야외 GPS + 나침반 화살표 길안내 (센서가 없으면 표지판 안내로 자동 전환)
 *  화면 3: 병원 실내 한 걸음 안내 + 직원에게 보여주는 도움 요청 카드
 *  개인정보: 이름·환자번호·음성 녹음은 저장하지 않음. 마지막 확인 지점만 이 기기에 저장.
 */
(() => {
  "use strict";
  const R = window.ROUTE;
  const $ = (s) => document.querySelector(s);
  const main = $("#main"), dock = $("#dock"), stepbar = $("#stepbar");

  // ───────────────────────── 저장 (이 기기에만) ─────────────────────────
  const store = {
    get(k, d) { try { const v = localStorage.getItem("hg:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("hg:" + k, JSON.stringify(v)); } catch {} },
    clear() { try { Object.keys(localStorage).filter(k => k.startsWith("hg:")).forEach(k => localStorage.removeItem(k)); } catch {} }
  };

  const state = {
    screen: store.get("screen", "talk"),   // talk | confirm | apply | outdoor | indoor | done
    slots: store.get("slots", { hospital: null, firstVisit: null, mobility: null, reception: null }),
    heard: "",
    outIdx: store.get("outIdx", 0),
    inIdx: store.get("inIdx", 0),
    sound: store.get("sound", true),
    rate: store.get("rate", 0.92),
    voiceURI: store.get("voiceURI", ""),
    demo: store.get("demo", false),
    reduce: store.get("reduce", matchMedia("(prefers-reduced-motion: reduce)").matches),
    lastSaid: ""
  };
  const save = () => {
    ["screen", "slots", "outIdx", "inIdx", "sound", "rate", "voiceURI", "demo", "reduce"].forEach(k => store.set(k, state[k]));
  };

  // ───────────────────────── 서버(선택) 확인 ─────────────────────────
  // server.py 를 OPENAI_API_KEY 와 함께 실행하면 AI 해석과 자연스러운 AI 목소리를 씁니다.
  // 서버가 없으면 브라우저 안에서 규칙 기반 해석 + 기기 내장 한국어 목소리로 동작합니다.
  const server = { ai: false, tts: false };
  fetch("api/health").then(r => r.ok ? r.json() : null).then(j => {
    if (j) { server.ai = !!j.ai; server.tts = !!j.tts; }
    updateEngineInfo();
  }).catch(() => updateEngineInfo());

  // ───────────────────────── 목소리 (자연스럽게) ─────────────────────────
  const synth = window.speechSynthesis;
  let voices = [];
  const NATURAL_HINTS = [/natural/i, /online/i, /premium/i, /enhanced/i, /neural/i, /siri/i, /google/i, /yuna/i, /sunhi/i, /injoon/i];
  function scoreVoice(v) {
    if (!/^ko/i.test(v.lang)) return -1;
    let s = 1;
    NATURAL_HINTS.forEach((re, i) => { if (re.test(v.name)) s += 20 - i; });
    if (/compact/i.test(v.name)) s -= 10;
    if (!v.localService) s += 3; // 클라우드 음성이 대체로 더 자연스러움
    return s;
  }
  function loadVoices() {
    if (!synth) return;
    voices = synth.getVoices().filter(v => /^ko/i.test(v.lang)).sort((a, b) => scoreVoice(b) - scoreVoice(a));
    const sel = $("#voiceSelect");
    sel.innerHTML = "";
    if (server.tts) sel.append(new Option("AI 자연 음성 (서버)", "server"));
    voices.forEach(v => sel.append(new Option(v.name + (v.localService ? "" : " ☁︎"), v.voiceURI)));
    if (!sel.options.length) sel.append(new Option("한국어 목소리가 없어요", ""));
    sel.value = state.voiceURI && [...sel.options].some(o => o.value === state.voiceURI) ? state.voiceURI : sel.options[0].value;
  }
  if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }

  // 문장을 끊어 읽어 숨 쉬는 듯한 간격을 주고, 긴 문장이 중간에 끊기는 브라우저 문제를 피합니다.
  function splitSentences(t) {
    return t.replace(/\s+/g, " ").split(/(?<=[.!?…])\s+/).map(s => s.trim()).filter(Boolean);
  }
  let audioEl = null, speakToken = 0;
  function stopSpeaking() {
    speakToken++;
    if (synth) synth.cancel();
    if (audioEl) { audioEl.pause(); audioEl = null; }
  }
  async function speak(text, { force = false } = {}) {
    state.lastSaid = text;
    if (!state.sound && !force) return;
    stopSpeaking();
    const token = speakToken;
    const useServer = server.tts && ($("#voiceSelect").value === "server");
    if (useServer) {
      try {
        const r = await fetch("api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, speed: state.rate }) });
        if (!r.ok) throw new Error("tts");
        const blob = await r.blob();
        if (token !== speakToken) return;
        audioEl = new Audio(URL.createObjectURL(blob));
        await audioEl.play();
        return;
      } catch { /* 기기 목소리로 넘어감 */ }
    }
    if (!synth) return;
    const v = voices.find(x => x.voiceURI === $("#voiceSelect").value) || voices[0];
    splitSentences(text).forEach((s, i) => {
      const u = new SpeechSynthesisUtterance(s);
      u.lang = "ko-KR"; if (v) u.voice = v;
      u.rate = state.rate; u.pitch = 1.0; u.volume = 1;
      synth.speak(u);
    });
  }
  function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch {} }

  // ───────────────────────── 음성 인식 ─────────────────────────
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function listen(onText, btn) {
    if (!SR) { alert("이 브라우저는 음성 인식을 지원하지 않아요. 아래 버튼으로 골라 주세요."); return; }
    stopSpeaking();
    const rec = new SR();
    rec.lang = "ko-KR"; rec.interimResults = true; rec.maxAlternatives = 1; rec.continuous = false;
    let finalText = "";
    btn.classList.add("listening"); btn.textContent = "🎙 듣고 있어요… (다 말하면 잠깐 멈추세요)";
    rec.onresult = (e) => {
      let t = ""; for (const r of e.results) t += r[0].transcript;
      finalText = t;
      const q = $("#heardLive"); if (q) q.textContent = "“" + t + "”";
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        speak("마이크를 쓸 수 없어요. 화면의 큰 버튼을 눌러서 골라 주세요.");
      }
    };
    rec.onend = () => {
      btn.classList.remove("listening"); btn.textContent = "🎙 누르고 말하기";
      if (finalText.trim()) onText(finalText.trim());
    };
    rec.start();
  }

  // ───────────────────────── AI 방문 조건 해석 ─────────────────────────
  // 네 가지 항목만 뽑음: 병원, 첫 방문 여부, 이동 도움, 접수 도움
  function localParse(text) {
    const t = text.replace(/\s+/g, "");
    const out = {};
    if (/분당서울대|서울대병원|서울대학교병원|분당서울|서울대/.test(t)) out.hospital = "분당서울대학교병원";
    else { const m = text.match(/([가-힣A-Za-z]{2,}(?:대학교)?병원)/); if (m) out.hospital = m[1]; }

    if (/처음|첫방문|첫진료|초진|첨가|첨이|한번도안/.test(t)) out.firstVisit = true;
    else if (/다녀|가봤|가본|재진|두번째|또가|다니는|다니던|진료받던/.test(t)) out.firstVisit = false;

    if (/휠체어/.test(t)) out.mobility = "휠체어";
    else if (/보행기|워커|유모차/.test(t)) out.mobility = "보행기";
    else if (/지팡이/.test(t)) out.mobility = "지팡이";
    else if (/혼자잘걸|걷는건괜찮|잘걸어/.test(t)) out.mobility = "도움 필요 없음";
    else if (/걷기힘|다리가|무릎|거동/.test(t)) out.mobility = "걷기 힘듦";

    if (/접수|수납|창구|서류/.test(t) && !/접수는혼자|접수는제가|접수는괜찮/.test(t)) out.reception = true;
    else if (/접수는혼자|접수는제가|접수는괜찮|혼자할수/.test(t)) out.reception = false;
    else if (/도와줄사람|같이가줄|동행|데려다/.test(t) && out.reception == null) out.reception = true;
    return out;
  }
  async function aiParse(text) {
    if (server.ai) {
      try {
        const r = await fetch("api/parse", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
        if (r.ok) { const j = await r.json(); return { ...localParse(text), ...clean(j) }; }
      } catch {}
    }
    return localParse(text);
  }
  function clean(j) {
    const o = {};
    if (typeof j.hospital === "string" && j.hospital) o.hospital = j.hospital;
    if (typeof j.firstVisit === "boolean") o.firstVisit = j.firstVisit;
    if (typeof j.mobility === "string" && j.mobility) o.mobility = j.mobility;
    if (typeof j.reception === "boolean") o.reception = j.reception;
    return o;
  }

  const SLOT_DEF = [
    { key: "hospital", label: "병원", ask: "어느 병원에 가세요?", options: [["분당서울대학교병원", "분당서울대병원"]] , fmt: v => v },
    { key: "firstVisit", label: "방문", ask: "이 병원에 처음 가시는 건가요?", options: [[true, "처음 가요"], [false, "가 봤어요"]], fmt: v => v ? "처음 방문 (초진)" : "다시 방문 (재진)" },
    { key: "mobility", label: "이동", ask: "걸을 때 무엇을 쓰세요?", options: [["보행기", "보행기"], ["휠체어", "휠체어"], ["지팡이", "지팡이"], ["도움 필요 없음", "혼자 잘 걸어요"]], fmt: v => v === "도움 필요 없음" ? "이동 도움 필요 없음" : v + " 이동 도움" },
    { key: "reception", label: "원내", ask: "병원 안에서 접수도 도와 드릴까요?", options: [[true, "네, 도와주세요"], [false, "혼자 할게요"]], fmt: v => v ? "접수 도움 필요" : "접수는 혼자" }
  ];
  const missingSlots = () => SLOT_DEF.filter(d => state.slots[d.key] == null);

  // ───────────────────────── 화면 공통 ─────────────────────────
  function setStep(title, sub) { stepbar.innerHTML = `<span>${title}</span>${sub ? `<small>${sub}</small>` : ""}`; }
  function btn(label, cls, onClick, extra = {}) {
    const b = document.createElement("button");
    b.className = "btn " + cls; b.innerHTML = label; b.addEventListener("click", onClick);
    Object.assign(b, extra); return b;
  }
  function row(...els) { const d = document.createElement("div"); d.className = "row2"; d.append(...els); return d; }
  function go(screen) { state.screen = screen; save(); stopNav(); render(); window.scrollTo(0, 0); }
  const replayBtn = () => btn("🔁 다시 듣기", "btn-light", () => speak(state.lastSaid, { force: true }));
  const helpBtn = () => btn("🙋 도움 요청", "btn-help", openHelp);

  function openHelp() {
    const s = state.slots;
    let where = "";
    if (state.screen === "outdoor") where = `지금 “${R.outdoor[state.outIdx].place}”(으)로 가는 중입니다.`;
    else if (state.screen === "indoor") where = "1동 1층 ‘처음오신 창구’를 찾고 있습니다.";
    const lines = [
      `${s.hospital || "분당서울대학교병원"}${s.firstVisit === false ? "에 진료 받으러 왔습니다." : " 첫 방문입니다."}`,
      s.mobility && s.mobility !== "도움 필요 없음" ? `${s.mobility}를 사용 중입니다.` : "",
      where,
      state.screen === "indoor" || state.screen === "outdoor" ? "1동 1층 처음오신 창구 가는 길을 알려 주세요." : "도와주세요.",
    ].filter(Boolean);
    $("#helpText").innerHTML = lines.join("<br>");
    $("#helpCard").hidden = false;
    vibrate(80);
    speak("직원분께 이 화면을 보여 주세요.");
  }
  $("#helpClose").onclick = () => { $("#helpCard").hidden = true; };

  // ───────────────────────── 화면 1: 말하기 ─────────────────────────
  function renderTalk() {
    setStep("1. 방문 준비", "말로 알려 주세요");
    main.innerHTML = `
      <section class="card">
        <p class="big">어느 병원에 가시는지<br>편하게 말씀해 주세요.</p>
        <p class="muted" style="margin-top:10px">예) “분당서울대병원 처음 가는데 보행기 쓰고 접수도 도와줄 사람 필요해요”</p>
        <p id="heardLive" class="quote" ${state.heard ? "" : "hidden"}>${state.heard ? "“" + state.heard + "”" : ""}</p>
      </section>
      <section class="card">
        <p class="muted">말하기 어려우면 아래 버튼을 누르세요.</p>
        <div class="choices">
          <button class="btn btn-light" data-q="분당서울대병원 처음 가요. 보행기 쓰고 접수도 도와주세요">보행기 · 첫 방문</button>
          <button class="btn btn-light" data-q="분당서울대병원 처음 가요. 휠체어 타고 접수도 도와주세요">휠체어 · 첫 방문</button>
        </div>
      </section>`;
    main.querySelectorAll("[data-q]").forEach(b => b.onclick = () => handleUtterance(b.dataset.q));
    const talk = btn("🎙 누르고 말하기", "btn-xl btn-talk", () => listen(handleUtterance, talk));
    dock.replaceChildren(talk, row(replayBtn(), btn("✋ 직접 고르기", "btn-light", () => { go("confirm"); })));
    speak("안녕하세요. 병원 한걸음입니다. 노란 버튼을 누르고, 어느 병원에 가시는지 편하게 말씀해 주세요.");
  }
  async function handleUtterance(text) {
    state.heard = text;
    const live = $("#heardLive"); if (live) { live.hidden = false; live.textContent = "“" + text + "” — 정리하는 중…"; }
    const got = await aiParse(text);
    Object.entries(got).forEach(([k, v]) => { if (v != null) state.slots[k] = v; });
    save(); go("confirm");
  }

  // ───────────────────────── 화면 1-2: AI 정리 확인 ─────────────────────────
  function renderConfirm() {
    setStep("1. 방문 준비", "내용이 맞는지 확인");
    const miss = missingSlots();
    main.innerHTML = `
      ${state.heard ? `<section class="card"><p class="muted">어르신 말씀</p><p class="quote">“${esc(state.heard)}”</p></section>` : ""}
      <section class="slots" id="slots"></section>
      <section id="askBox"></section>`;
    const box = $("#slots");
    SLOT_DEF.forEach(d => {
      const v = state.slots[d.key];
      const el = document.createElement("div");
      el.className = "slot" + (v == null ? " missing" : "");
      el.innerHTML = `<div><div class="k">${d.label}</div><div class="v">${v == null ? "아직 몰라요" : d.fmt(v)}</div></div>`;
      el.append(btn("고치기", "edit", () => askSlot(d)));
      box.append(el);
    });
    if (miss.length) {
      askSlot(miss[0]);
      dock.replaceChildren(btn("🎙 다시 말하기", "btn-xl btn-talk", () => go("talk")), row(replayBtn(), helpBtn()));
    } else {
      const s = state.slots;
      const summary = `${s.hospital}, ${SLOT_DEF[1].fmt(s.firstVisit)}, ${SLOT_DEF[2].fmt(s.mobility)}, ${SLOT_DEF[3].fmt(s.reception)}. 이렇게 정리했어요. 맞으면 맞아요 버튼을 눌러 주세요.`;
      dock.replaceChildren(
        btn("✅ 맞아요 · 동행 신청 안내", "btn-xl btn-primary", () => go("apply")),
        row(replayBtn(), btn("🎙 다시 말하기", "btn-light", () => go("talk")))
      );
      speak(summary);
    }
  }
  function askSlot(d) {
    const ask = $("#askBox");
    ask.innerHTML = `<div class="card"><p class="big" style="font-size:26px">${d.ask}</p><div class="choices"></div></div>`;
    const c = ask.querySelector(".choices");
    d.options.forEach(([val, label]) => c.append(btn(label, "btn-light", () => { state.slots[d.key] = val; save(); renderConfirm(); })));
    if (d.key === "hospital") c.append(btn("🎙 말로 하기", "btn-talk", function () { listen(t => { const g = localParse(t); state.slots.hospital = g.hospital || t; save(); renderConfirm(); }, this); }));
    ask.scrollIntoView({ behavior: state.reduce ? "auto" : "smooth", block: "nearest" });
    speak(d.ask);
  }

  // ───────────────────────── 동행 신청 안내 ─────────────────────────
  function renderApply() {
    setStep("1. 방문 준비", "병원동행 신청");
    const c = R.companion, needs = state.slots.reception || (state.slots.mobility && state.slots.mobility !== "도움 필요 없음");
    main.innerHTML = `
      <section class="card">
        <p class="big">${needs ? "같이 가 줄 분을<br>신청할 수 있어요." : "혼자 가셔도 길을<br>알려 드릴게요."}</p>
        <p class="muted" style="margin-top:8px">${c.name}</p>
        <ul style="padding-left:22px;margin:10px 0 0">${c.conditions.map(x => `<li>${x}</li>`).join("")}</ul>
        <p class="muted" style="margin-top:10px;font-size:15px">출처: ${c.source}</p>
      </section>
      <section class="card">
        <p class="muted">원하는 시간에 매니저 배정이 어렵다고 하면?</p>
        <p style="margin:6px 0 0">운영기관에 <b>“다른 가능한 시간이 언제인가요?”</b> 하고 물어보세요. 그래도 안 되면 <b>혼자 가는 길 안내</b>를 바로 시작할 수 있어요.</p>
      </section>`;
    const openBtn = btn("📞 성남시 동행 신청 열기", "btn-xl btn-primary", () => {
      if (c.phone) location.href = "tel:" + c.phone.replace(/[^0-9]/g, "");
      else window.open(c.url, "_blank", "noopener");
    });
    dock.replaceChildren(openBtn, btn("🧭 길 안내 시작 (미금역에서)", "btn-xl btn-light", () => { state.outIdx = store.get("outIdx", 0); go("outdoor"); }), row(replayBtn(), helpBtn()));
    speak(needs
      ? "성남시에는 병원까지 같이 가 주는 병원동행 서비스가 있어요. 위쪽 초록 버튼을 누르면 신청하는 곳이 열립니다. 원하는 시간에 안 된다고 하면, 다른 가능한 시간을 물어보세요. 혼자 가실 때는 아래 길 안내 시작 버튼을 누르세요."
      : "혼자 가셔도 괜찮아요. 길 안내 시작 버튼을 누르면 미금역부터 한 걸음씩 알려 드릴게요.");
  }

  // ───────────────────────── 화면 2: 야외 GPS 길안내 ─────────────────────────
  const nav = { watchId: null, pos: null, acc: null, heading: null, headingAt: 0, lastDirWord: "", lastDirSpokeAt: 0, arrived: false, nearSaid: false, demoTimer: null, orientHandler: null, sensorAsked: false };

  const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
  function distanceM(a, b) {
    const R0 = 6371000, dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R0 * Math.asin(Math.sqrt(h));
  }
  function bearing(a, b) {
    const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
    const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }
  const norm180 = d => ((d + 540) % 360) - 180;
  function dirWord(rel) {
    const a = Math.abs(rel);
    if (a < 25) return "앞으로 곧장";
    if (a < 70) return rel > 0 ? "오른쪽 앞으로" : "왼쪽 앞으로";
    if (a < 120) return rel > 0 ? "오른쪽으로" : "왼쪽으로";
    return "뒤로 돌아서";
  }
  function distText(m) {
    if (m < 10) return "바로 앞";
    if (m < 1000) return Math.round(m / 5) * 5 + "m";
    return (m / 1000).toFixed(1) + "km";
  }
  function distSpeech(m) {
    if (m < 10) return "바로 앞이에요";
    const steps = Math.max(5, Math.round(m / 0.6 / 5) * 5); // 어르신 보폭 약 60cm
    return `${Math.round(m / 5) * 5}미터, 약 ${steps}걸음 남았어요`;
  }

  async function askSensorPermission() {
    // iOS 13+ 는 사용자가 버튼을 눌러야 방향 센서를 허용할 수 있음
    try {
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        const r = await DeviceOrientationEvent.requestPermission();
        return r === "granted";
      }
    } catch {}
    return true;
  }
  function startCompass() {
    if (nav.orientHandler) return;
    const handler = (e) => {
      let h = null;
      if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading;              // iOS
      else if (e.absolute && typeof e.alpha === "number") h = (360 - e.alpha) % 360;             // Android(절대 방위)
      if (h == null || isNaN(h)) return;
      // 화면 회전 보정
      const so = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
      h = (h + so + 360) % 360;
      // 흔들림 줄이기 (원형 저역통과)
      if (nav.heading == null) nav.heading = h;
      else nav.heading = (nav.heading + norm180(h - nav.heading) * 0.25 + 360) % 360;
      nav.headingAt = Date.now();
      updateNavUI();
    };
    nav.orientHandler = handler;
    if ("ondeviceorientationabsolute" in window) window.addEventListener("deviceorientationabsolute", handler);
    window.addEventListener("deviceorientation", handler);
  }
  function stopCompass() {
    if (!nav.orientHandler) return;
    window.removeEventListener("deviceorientationabsolute", nav.orientHandler);
    window.removeEventListener("deviceorientation", nav.orientHandler);
    nav.orientHandler = null;
  }
  function startGPS() {
    if (state.demo) return startDemo();
    if (!("geolocation" in navigator)) { setGpsStatus("이 기기는 위치(GPS)를 쓸 수 없어요. 표지판 안내를 따라가세요.", true); return; }
    if (!isSecureContext) setGpsStatus("위치를 쓰려면 https 주소로 열어야 해요.", true);
    nav.watchId = navigator.geolocation.watchPosition(
      (p) => { nav.pos = { lat: p.coords.latitude, lng: p.coords.longitude }; nav.acc = p.coords.accuracy;
               if (nav.heading == null && p.coords.heading != null && !isNaN(p.coords.heading) && p.coords.speed > 0.5) nav.heading = p.coords.heading;
               updateNavUI(); },
      (err) => {
        const msg = err.code === 1 ? "위치 권한이 꺼져 있어요. 표지판 안내와 ‘도착했어요’ 버튼으로 가실 수 있어요." : "위치를 찾는 중이에요. 하늘이 보이는 곳에서 잠시 기다려 주세요.";
        setGpsStatus(msg, true);
        if (err.code === 1 && !nav.permSaid) { nav.permSaid = true; speak("위치 권한이 꺼져 있어요. 표지판을 보고 가시다가, 도착하면 도착했어요 버튼을 눌러 주세요."); }
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
    );
  }
  // 시연 모드: 실제 GPS 대신 목적지 쪽으로 조금씩 걸어가는 것처럼 위치를 움직임
  function startDemo() {
    const step = R.outdoor[state.outIdx];
    const prev = state.outIdx > 0 ? R.outdoor[state.outIdx - 1] : { lat: step.lat - 0.0012, lng: step.lng - 0.0009 };
    nav.pos = nav.pos || { lat: prev.lat, lng: prev.lng }; nav.acc = 5;
    if (nav.heading == null) { nav.heading = bearing(nav.pos, step) + 50; nav.demoHeading = true; }
    clearInterval(nav.demoTimer);
    nav.demoTimer = setInterval(() => {
      const t = R.outdoor[state.outIdx]; if (!t) return;
      const d = distanceM(nav.pos, t);
      const speed = t.type === "bus" ? 120 : 9; // m / tick
      const f = Math.min(1, speed / Math.max(d, 1));
      nav.pos = { lat: nav.pos.lat + (t.lat - nav.pos.lat) * f, lng: nav.pos.lng + (t.lng - nav.pos.lng) * f };
      if (nav.demoHeading) nav.heading = (nav.heading + norm180(bearing(nav.pos, t) - nav.heading) * 0.35 + 360) % 360;
      nav.headingAt = Date.now();
      updateNavUI();
    }, 1500);
  }
  function stopNav() {
    if (nav.watchId != null) navigator.geolocation.clearWatch(nav.watchId);
    nav.watchId = null; clearInterval(nav.demoTimer); nav.demoTimer = null;
    stopCompass();
  }
  function setGpsStatus(t, bad) { const el = $("#gpsStatus"); if (el) { el.textContent = t; el.classList.toggle("bad", !!bad); } }

  function renderOutdoor() {
    const i = state.outIdx, step = R.outdoor[i];
    if (!step) return go("indoor");
    nav.arrived = false; nav.nearSaid = false; nav.lastDirWord = ""; nav.lastDirSpokeAt = 0;
    setStep(`2. 가는 길 ${i + 1}/${R.outdoor.length}`, step.type === "bus" ? "버스 타기" : "걷기");
    main.innerHTML = `
      <div class="progress">${R.outdoor.map((_, k) => `<i class="${k <= i ? "on" : ""}"></i>`).join("")}</div>
      <section class="card">
        <p class="muted">지금 할 일 ${step.verified ? "" : '<span class="badge">현장 확인 전</span>'}</p>
        <p class="big">${step.screen}</p>
      </section>
      <section class="card compass-wrap">
        <div class="compass">
          <svg class="arrow" id="arrow" viewBox="0 0 100 100" aria-hidden="true">
            <path d="M50 4 L86 56 L62 56 L62 96 L38 96 L38 56 L14 56 Z"/>
          </svg>
        </div>
        <div class="dir-word" id="dirWord">위치를 찾는 중…</div>
        <div class="dist" id="dist">–</div>
        <div class="gps-status" id="gpsStatus">GPS 연결 중</div>
        <button id="sensorBtn" class="btn btn-light" hidden>🧭 방향 센서 켜기</button>
      </section>
      <section class="sign" id="signBox">🪧 ${step.sign}</section>`;
    $("#arrow").parentElement.classList.toggle("reduce", state.reduce);
    const arrive = btn(step.type === "bus" ? "🚌 버스에서 내렸어요" : "📍 여기에 도착했어요 · 다음", "btn-xl btn-primary", () => nextOutdoor());
    dock.replaceChildren(arrive, row(replayBtn(), helpBtn()));
    main.append(row(
      btn("⬅ 이전 지점", "btn-light", () => { if (state.outIdx > 0) { state.outIdx--; save(); renderOutdoor(); } else go("apply"); }),
      btn("🏥 1동에 들어왔어요", "btn-light", () => { state.inIdx = 0; go("indoor"); })
    ));

    // 센서 권한: iOS 는 버튼 눌러야 함
    const needsTap = typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function";
    if (needsTap && !nav.sensorAsked) {
      const sb = $("#sensorBtn"); sb.hidden = false;
      sb.onclick = async () => { nav.sensorAsked = true; sb.hidden = true; if (await askSensorPermission()) startCompass(); };
    } else startCompass();
    startGPS();
    speak(step.voice);
    // 3초 뒤에도 나침반 값이 없으면 지도 기준(북쪽=위) 화살표로 안내
    setTimeout(() => { if (state.screen === "outdoor") updateNavUI(); }, 3000);
  }

  function updateNavUI() {
    if (state.screen !== "outdoor") return;
    const step = R.outdoor[state.outIdx]; if (!step) return;
    const arrow = $("#arrow"); if (!arrow) return;
    if (!nav.pos) { $("#dirWord").textContent = "위치를 찾는 중…"; return; }
    const d = distanceM(nav.pos, step), b = bearing(nav.pos, step);
    const compassOk = nav.heading != null && Date.now() - nav.headingAt < 4000;
    const rel = compassOk ? norm180(b - nav.heading) : norm180(b);
    arrow.style.transform = `rotate(${rel}deg)`;
    $("#dist").textContent = distText(d);

    const weak = nav.acc != null && nav.acc > 45;
    if (step.type === "bus") {
      $("#dirWord").textContent = d < (step.nearRadius || 400) ? "곧 내려요!" : "버스를 타고 가는 중";
      setGpsStatus(`서울대병원 정류장까지 ${distText(d)}${weak ? " · 위치 오차가 커요" : ""}`, weak);
      if (!nav.nearSaid && d < (step.nearRadius || 400)) {
        nav.nearSaid = true; vibrate([200, 100, 200]);
        speak("곧 서울대병원 정류장이에요. 하차 벨을 누르고, 버스가 완전히 멈추면 천천히 내리세요.");
      }
      if (!nav.arrived && d < step.arriveRadius) { nav.arrived = true; vibrate([300, 100, 300]); speak("서울대병원 정류장에 도착했어요. 지금 내리세요. 내리시면 버스에서 내렸어요 버튼을 눌러 주세요."); }
      return;
    }

    const word = compassOk ? dirWord(rel) : "화살표 쪽으로 (위쪽 = 북쪽)";
    $("#dirWord").textContent = d < step.arriveRadius ? "거의 다 왔어요!" : word;
    setGpsStatus(
      (compassOk ? "휴대폰이 향하는 방향 기준" : "방향 센서가 없어 지도 기준으로 보여 드려요. 표지판도 함께 보세요.") +
      (weak ? ` · 위치 오차 약 ${Math.round(nav.acc)}m` : ""), !compassOk || weak);

    // 도착 판정
    if (!nav.arrived && d < step.arriveRadius + Math.min(nav.acc || 0, 15)) {
      nav.arrived = true; vibrate([300, 100, 300]);
      speak(`${step.place}에 도착했어요. 확인하셨으면 아래 도착했어요 버튼을 눌러 주세요.`);
      return;
    }
    // 방향이 바뀌었을 때만, 너무 자주 말하지 않게 (최소 12초 간격)
    const now = Date.now();
    if (compassOk && word !== nav.lastDirWord && now - nav.lastDirSpokeAt > 12000 && !nav.arrived) {
      nav.lastDirWord = word; nav.lastDirSpokeAt = now;
      speak(`${word} 가세요. ${distSpeech(d)}.`);
    } else if (now - nav.lastDirSpokeAt > 45000 && !nav.arrived) {
      nav.lastDirSpokeAt = now;
      speak(`${compassOk ? word + " " : ""}${distSpeech(d)}. 천천히 가세요.`);
    }
  }
  function nextOutdoor() {
    state.outIdx++; save(); vibrate(60);
    if (state.outIdx >= R.outdoor.length) { state.inIdx = 0; go("indoor"); }
    else renderOutdoor();
  }

  // ───────────────────────── 화면 3: 실내 한 걸음 안내 ─────────────────────────
  function renderIndoor() {
    const i = state.inIdx, step = R.indoor[i];
    if (!step) return go("done");
    setStep(`3. 병원 안 ${i + 1}/${R.indoor.length}`, `창구까지 ${R.indoor.length - i}단계`);
    main.innerHTML = `
      <div class="progress">${R.indoor.map((_, k) => `<i class="${k <= i ? "on" : ""}"></i>`).join("")}</div>
      <section class="card">
        <p class="muted">지금 할 일 한 가지 ${step.verified ? "" : '<span class="badge">현장 확인 전</span>'}</p>
        <p class="big">${step.screen}</p>
      </section>
      <section class="sign">🪧 ${step.sign}</section>
      <section class="card"><p class="muted">소리를 꺼도 화면 글씨와 버튼만으로 끝까지 갈 수 있어요. 마지막으로 확인한 곳을 기억해 둡니다.</p></section>`;
    dock.replaceChildren(
      btn(i === R.indoor.length - 1 ? "✅ 창구에 도착했어요" : "👍 했어요 · 다음", "btn-xl btn-primary", () => { state.inIdx++; save(); vibrate(60); renderIndoor(); }),
      row(replayBtn(), btn("⬅ 이전 단계", "btn-light", () => { if (state.inIdx > 0) { state.inIdx--; save(); renderIndoor(); } else { state.outIdx = R.outdoor.length - 1; go("outdoor"); } })),
      btn("🙋 직원에게 보여줄 도움 문장 크게 켜기", "btn-xl btn-help", openHelp)
    );
    speak(step.voice);
  }

  function renderDone() {
    setStep("도착!", "수고하셨어요");
    main.innerHTML = `<section class="card"><p class="big">처음오신 창구에<br>잘 도착하셨어요. 👏</p>
      <p style="margin-top:12px">번호가 불리면 창구에서 <b>“오늘 예약하고 처음 왔어요”</b> 라고 말씀하세요.</p></section>`;
    dock.replaceChildren(btn("🏠 처음 화면으로", "btn-xl btn-light", () => resetAll()), row(replayBtn(), helpBtn()));
    speak("처음오신 창구에 잘 도착하셨어요. 정말 수고 많으셨어요. 번호가 불리면 창구에서, 오늘 예약하고 처음 왔다고 말씀하세요.");
  }

  // ───────────────────────── 렌더 ─────────────────────────
  function render() {
    document.body.classList.toggle("reduce", state.reduce);
    ({ talk: renderTalk, confirm: renderConfirm, apply: renderApply, outdoor: renderOutdoor, indoor: renderIndoor, done: renderDone }[state.screen] || renderTalk)();
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function resetAll() {
    stopSpeaking(); stopNav(); store.clear();
    Object.assign(state, { screen: "talk", slots: { hospital: null, firstVisit: null, mobility: null, reception: null }, heard: "", outIdx: 0, inIdx: 0 });
    nav.pos = null; nav.heading = null; save(); render();
  }

  // ───────────────────────── 상단 버튼 / 설정 ─────────────────────────
  const soundBtn = $("#btnSound");
  function paintSound() { soundBtn.textContent = state.sound ? "🔊 소리 켬" : "🔇 소리 끔"; soundBtn.setAttribute("aria-pressed", state.sound); }
  soundBtn.onclick = () => { state.sound = !state.sound; if (!state.sound) stopSpeaking(); save(); paintSound(); };
  paintSound();

  function updateEngineInfo() {
    loadVoices();
    $("#engineInfo").textContent =
      `말 알아듣기: ${server.ai ? "AI(GPT) 해석" : "기기 안 규칙 해석"} · 목소리: ${server.tts ? "AI 자연 음성 사용 가능" : "기기 내장 한국어 음성"} · 음성 인식: ${SR ? "사용 가능" : "지원 안 됨"}`;
  }
  $("#btnSettings").onclick = () => {
    $("#rateInput").value = state.rate; $("#rateVal").textContent = state.rate.toFixed(2) + "배";
    $("#demoToggle").checked = state.demo; $("#reduceMotion").checked = state.reduce;
    updateEngineInfo(); $("#settings").hidden = false;
  };
  $("#settingsClose").onclick = () => { $("#settings").hidden = true; if (state.screen === "outdoor") render(); };
  $("#voiceSelect").onchange = (e) => { state.voiceURI = e.target.value; save(); };
  $("#rateInput").oninput = (e) => { state.rate = +e.target.value; $("#rateVal").textContent = state.rate.toFixed(2) + "배"; save(); };
  $("#demoToggle").onchange = (e) => { state.demo = e.target.checked; nav.pos = null; nav.heading = null; save(); };
  $("#reduceMotion").onchange = (e) => { state.reduce = e.target.checked; save(); document.body.classList.toggle("reduce", state.reduce); };
  $("#testVoice").onclick = () => speak("안녕하세요. 병원 한걸음이에요. 천천히, 한 걸음씩 같이 가요.", { force: true });
  $("#resetAll").onclick = () => { $("#settings").hidden = true; resetAll(); };

  // 브라우저 자동재생 정책: 첫 터치 후에야 소리가 나므로, 첫 터치 때 현재 안내를 다시 읽음
  let unlocked = false;
  document.addEventListener("pointerdown", (e) => {
    if (unlocked) return; unlocked = true;
    if (e.target.closest("button, select, input")) return;
    if (synth && !synth.speaking && state.lastSaid && state.sound) setTimeout(() => { if (!synth.speaking) speak(state.lastSaid); }, 50);
  }, { once: false, capture: true });

  render();
})();
