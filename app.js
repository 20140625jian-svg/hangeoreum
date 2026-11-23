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
    clear() { try { Object.keys(localStorage).filter(k => k.startsWith("hg:") && k !== "hg:permDone").forEach(k => localStorage.removeItem(k)); } catch {} }
  };

  const state = {
    screen: store.get("screen", store.get("permDone", false) ? "talk" : "perm"),   // talk | confirm | apply | outdoor | indoor | done
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
  state.dest = store.get("dest", null);           // null = 분당서울대 확인 경로, {name,lat,lng} = 지도에서 고른 곳
  const isPreset = () => !state.dest;
  function RT() {
    if (isPreset()) return R;
    const d = state.dest;
    return {
      outdoor: [{
        id: "c1", type: "walk", place: d.name,
        screen: `${d.name}(으)로 가세요.`,
        voice: `${d.name}(으)로 안내를 시작할게요. 화살표가 가리키는 쪽으로 천천히 걸어가세요. 큰길과 횡단보도를 이용하세요.`,
        sign: "가까이 가면 건물 간판의 이름을 꼭 확인하세요. 지도의 직선 방향이라 실제 길은 조금 다를 수 있어요.",
        lat: d.lat, lng: d.lng, arriveRadius: 35, verified: true
      }],
      indoor: []
    };
  }
  const save = () => {
    store.set("dest", state.dest);
    ["screen", "slots", "outIdx", "inIdx", "sound", "rate", "voiceURI", "demo", "reduce"].forEach(k => store.set(k, state[k]));
  };

  // ───────────────────────── 서버(선택) 확인 ─────────────────────────
  // server.py 를 OPENAI_API_KEY 와 함께 실행하면 AI 해석과 자연스러운 AI 목소리를 씁니다.
  // 서버가 없으면 브라우저 안에서 규칙 기반 해석 + 기기 내장 한국어 목소리로 동작합니다.
  const server = { ai: false, tts: false, data: false, bus: false };
  const healthReady = fetch("api/health").then(r => r.ok ? r.json() : null).then(j => {
    if (j) { server.ai = !!j.ai; server.tts = !!j.tts; server.data = !!j.data; server.bus = !!j.bus; }
    updateEngineInfo();
  }).catch(() => updateEngineInfo());
  const healthDone = healthReady.catch(() => {});

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
  // 말하기: 브라우저 음성 인식 → 안 되면 휴대폰 키보드의 🎤(받아쓰기)로 대신 입력
  let activeRec = null;
  function listen(onText, btn) {
    if (activeRec) { activeRec.stop(); return; }           // 한 번 더 누르면 멈춤
    if (!SR || !isSecureContext) return typeFallback(onText, "이 브라우저는 바로 듣기를 지원하지 않아요.");
    stopSpeaking();
    const label = btn.dataset.label || (btn.dataset.label = btn.innerHTML);
    let rec;
    try { rec = new SR(); } catch { return typeFallback(onText); }
    rec.lang = "ko-KR"; rec.interimResults = true; rec.maxAlternatives = 1; rec.continuous = false;
    let text = "", errored = "", silenceT = null, gotAny = false;
    const maxT = setTimeout(() => rec.stop(), 15000);
    const armSilence = () => { clearTimeout(silenceT); silenceT = setTimeout(() => rec.stop(), 2200); };
    btn.classList.add("listening"); btn.innerHTML = "🎙 듣고 있어요… 말씀하세요<br><small>다 말하면 다시 누르세요</small>";
    rec.onstart = () => vibrate(40);
    rec.onresult = (e) => {
      let t = ""; for (const r of e.results) t += r[0].transcript;
      text = t; gotAny = true; armSilence();
      const q = $("#heardLive"); if (q) { q.hidden = false; q.textContent = "“" + t + "”"; }
    };
    rec.onerror = (e) => { errored = e.error || "error"; };
    rec.onend = () => {
      activeRec = null; clearTimeout(maxT); clearTimeout(silenceT);
      btn.classList.remove("listening"); btn.innerHTML = label;
      if (text.trim()) return onText(text.trim());
      if (errored === "not-allowed" || errored === "service-not-allowed") {
        const why = isIOS
          ? "마이크나 받아쓰기가 꺼져 있어요. 설정 → Safari → 마이크 ‘허용’, 그리고 설정 → 일반 → 키보드 → ‘받아쓰기 활성화’를 켜 주세요."
          : "마이크가 꺼져 있어요. 주소창 왼쪽 버튼 → 권한 → 마이크 ‘허용’을 눌러 주세요.";
        speak(why);
        return typeFallback(onText, why);
      }
      if (errored === "audio-capture") { speak("다른 앱이 마이크를 쓰고 있어요."); return typeFallback(onText, "다른 앱이 마이크를 쓰고 있어요. 통화나 녹음을 끄고 다시 해 보세요."); }
      if (errored === "network" || errored === "language-not-supported") return typeFallback(onText, "인터넷이 약해서 바로 듣기가 안 돼요.");
      if (errored === "aborted") return;
      // no-speech 또는 아무 말도 못 들음
      speak("잘 안 들렸어요. 노란 버튼을 누르고, 휴대폰에 입을 가까이 대고 말씀해 주세요.");
      if (!gotAny) listen.miss = (listen.miss || 0) + 1;
      if (listen.miss >= 2) { listen.miss = 0; typeFallback(onText, "잘 안 들려서 다른 방법으로 해 볼게요."); }
    };
    activeRec = rec;
    try { rec.start(); silenceT = setTimeout(() => rec.stop(), 7000); }
    catch { activeRec = null; btn.classList.remove("listening"); btn.innerHTML = label; typeFallback(onText); }
  }

  // 대체 입력: 휴대폰 키보드의 🎤 버튼(받아쓰기)은 거의 모든 휴대폰에서 됩니다
  function typeFallback(onText, reason = "") {
    const old = $("#typeSheet"); if (old) old.remove();
    const wrap = document.createElement("div");
    wrap.id = "typeSheet"; wrap.className = "overlay sheet"; wrap.setAttribute("role", "dialog");
    wrap.innerHTML = `<div class="sheet-inner">
        ${reason ? `<p class="muted">${esc(reason)}</p>` : ""}
        <p class="big" style="font-size:26px">아래 칸을 누르고,<br>키보드의 <span class="kbd">🎤</span> 버튼을 눌러 말씀하세요.</p>
        <p class="muted">${isIOS ? "키보드 오른쪽 아래(또는 스페이스 옆)에 있는 마이크 모양이에요." : "키보드 위쪽 줄이나 오른쪽 위에 있는 마이크 모양이에요."} 글자로 써도 돼요.</p>
        <textarea id="typeBox" rows="3" placeholder="예) 분당서울대병원 처음 가요"></textarea>
        <button class="btn btn-xl btn-primary" id="typeOk">✅ 다 말했어요</button>
        <button class="btn btn-light" id="typeCancel">닫기</button>
      </div>`;
    document.body.append(wrap);
    const box = wrap.querySelector("#typeBox");
    setTimeout(() => box.focus(), 50);
    wrap.querySelector("#typeOk").onclick = () => { const t = box.value.trim(); wrap.remove(); if (t) onText(t); };
    wrap.querySelector("#typeCancel").onclick = () => wrap.remove();
    speak("아래 칸을 누르고, 키보드의 마이크 버튼을 눌러 말씀해 주세요.");
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
  function go(screen) { if (screen !== "doctor" && typeof docStopRec === "function") docStopRec(); state.screen = screen; save(); stopNav(); render(); window.scrollTo(0, 0); }
  const replayBtn = () => btn("🔁 다시 듣기", "btn-light", () => speak(state.lastSaid, { force: true }));
  const helpBtn = () => btn("🙋 도움 요청", "btn-help", openHelp);

  function openHelp() {
    const s = state.slots;
    let where = "";
    if (state.screen === "outdoor") where = `지금 “${RT().outdoor[state.outIdx].place}”(으)로 가는 중입니다.`;
    else if (state.screen === "indoor") where = "1동 1층 ‘처음오신 창구’를 찾고 있습니다.";
    const lines = [
      `${(!isPreset() && state.dest.name) || s.hospital || "분당서울대학교병원"}${s.firstVisit === false ? "에 진료 받으러 왔습니다." : " 첫 방문입니다."}`,
      s.mobility && s.mobility !== "도움 필요 없음" ? `${s.mobility}를 사용 중입니다.` : "",
      where,
      !isPreset() && state.screen === "outdoor" ? "이곳에 가는 길을 알려 주세요." :
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
      </section>
      <div class="row2"><button class="btn btn-light" id="goNearH">🏥 가까운 병원</button><button class="btn btn-light" id="goNearE">🚑 가까운 응급실</button></div>`;
    $("#goNearH").onclick = () => openNear("hosp"); $("#goNearE").onclick = () => openNear("er");
    main.querySelectorAll("[data-q]").forEach(b => b.onclick = () => handleUtterance(b.dataset.q));
    const talk = btn("🎙 누르고 말하기", "btn-xl btn-talk", () => listen(handleUtterance, talk));
    dock.replaceChildren(talk, row(btn("⌨️ 키보드로 말하기", "btn-light", () => typeFallback(handleUtterance)), btn("✋ 직접 고르기", "btn-light", () => { go("confirm"); })));
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
    dock.replaceChildren(openBtn, btn("🗺 어디로 갈지 지도에서 고르기", "btn-xl btn-light", () => go("pick")), row(replayBtn(), helpBtn()));
    speak(needs
      ? "성남시에는 병원까지 같이 가 주는 병원동행 서비스가 있어요. 위쪽 초록 버튼을 누르면 신청하는 곳이 열립니다. 원하는 시간에 안 된다고 하면, 다른 가능한 시간을 물어보세요. 혼자 가실 때는 아래 버튼을 눌러, 어디로 갈지 지도에서 골라 주세요."
      : "혼자 가셔도 괜찮아요. 아래 버튼을 눌러 어디로 갈지 고르시면, 한 걸음씩 알려 드릴게요.");
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
      nav.compassLive = true;
      if (!nav.raf) nav.raf = requestAnimationFrame(() => { nav.raf = 0; paintArrow(); });
      if (Date.now() - (nav.fullAt || 0) > 1000) { nav.fullAt = Date.now(); updateNavUI(); }
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
        if (err.code === 1 && !$("#fixPerm")) { const f = btn("📍 위치 권한 켜는 방법 보기", "btn-light", () => go("perm")); f.id = "fixPerm"; $("#gpsStatus").after(f); }
        if (err.code === 1 && !nav.permSaid) { nav.permSaid = true; speak("위치 권한이 꺼져 있어요. 표지판을 보고 가시다가, 도착하면 도착했어요 버튼을 눌러 주세요."); }
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
    );
  }
  // 시연 모드: 실제 GPS 대신 목적지 쪽으로 조금씩 걸어가는 것처럼 위치를 움직임
  function startDemo() {
    const step = RT().outdoor[state.outIdx];
    const prev = state.outIdx > 0 ? RT().outdoor[state.outIdx - 1] : { lat: step.lat - 0.0012, lng: step.lng - 0.0009 };
    nav.pos = nav.pos || { lat: prev.lat, lng: prev.lng }; nav.acc = 5;
    if (nav.heading == null) { nav.heading = bearing(nav.pos, step) + 50; nav.demoHeading = true; }
    clearInterval(nav.demoTimer);
    nav.demoTimer = setInterval(() => {
      const t = RT().outdoor[state.outIdx]; if (!t) return;
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
    if (typeof stopBus === "function") stopBus();
  }
  function setGpsStatus(t, bad) { const el = $("#gpsStatus"); if (el) { el.textContent = t; el.classList.toggle("bad", !!bad); } }

  function renderOutdoor() {
    const i = state.outIdx, step = RT().outdoor[i];
    if (!step) return go(RT().indoor.length ? "indoor" : "done");
    nav.arrived = false; nav.nearSaid = false; nav.lastDirWord = ""; nav.lastDirSpokeAt = 0; nav.arrowDeg = null; nav.ringDeg = null;
    setStep(`2. 가는 길 ${i + 1}/${RT().outdoor.length}`, step.type === "bus" ? "버스 타기" : "걷기");
    main.innerHTML = `
      <div class="progress">${RT().outdoor.map((_, k) => `<i class="${k <= i ? "on" : ""}"></i>`).join("")}</div>
      <section class="card">
        <p class="muted">지금 할 일 ${step.verified ? "" : '<span class="badge">현장 확인 전</span>'}</p>
        <p class="big">${step.screen}</p>
      </section>
      ${step.bus ? '<section class="card bus-card" id="busCard" hidden aria-live="polite"></section>' : ""}
      <section class="card compass-wrap">
        <div class="compass">
          <div class="ring" id="ring" aria-hidden="true"><b class="n">북</b><b class="e">동</b><b class="s">남</b><b class="w">서</b></div>
          <svg class="arrow" id="arrow" viewBox="0 0 100 100" aria-hidden="true">
            <path d="M50 4 L86 56 L62 56 L62 96 L38 96 L38 56 L14 56 Z"/>
          </svg>
        </div>
        <div class="compass-state" id="compassState"></div>
        <div class="dir-word" id="dirWord">위치를 찾는 중…</div>
        <div class="dist" id="dist">–</div>
        <div class="gps-status" id="gpsStatus">GPS 연결 중</div>
        <button id="sensorBtn" class="btn btn-light" hidden>🧭 방향 센서 켜기</button>
      </section>
      <section class="sign" id="signBox">🪧 ${step.sign}</section>
      <div id="miniMap" class="map mini" aria-label="내 위치와 목적지 지도"></div>`;
    makeMiniMap(step);
    startBus(step);
    $("#arrow").parentElement.classList.toggle("reduce", state.reduce);
    const arrive = btn(step.type === "bus" ? "🚌 버스에서 내렸어요" : "📍 여기에 도착했어요 · 다음", "btn-xl btn-primary", () => nextOutdoor());
    dock.replaceChildren(arrive, row(replayBtn(), helpBtn()));
    main.append(row(
      btn("⬅ 이전 지점", "btn-light", () => { if (state.outIdx > 0) { state.outIdx--; save(); renderOutdoor(); } else go("pick"); }),
      isPreset() ? btn("🏥 1동에 들어왔어요", "btn-light", () => { state.inIdx = 0; go("indoor"); })
                 : btn("🗺 목적지 바꾸기", "btn-light", () => go("pick"))
    ));

    // 센서 권한: iOS 는 버튼 눌러야 함
    const needsTap = typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function";
    if (needsTap && !nav.sensorAsked) {
      const sb = $("#sensorBtn"); sb.hidden = false;
      sb.onclick = async () => { sb.hidden = true; if (nav.orientHandler || nav.sensorAsked) return; nav.sensorAsked = true; const ok = await askSensorPermission(); nav.sensorAsked = true; perm.compass = ok ? "granted" : "denied"; if (ok) startCompass(); paintArrow(); };
    } else startCompass();
    startGPS();
    speak(step.voice);
    updateNavUI();
    // 3초 뒤에도 나침반 값이 없으면 지도 기준(북쪽=위) 화살표로 안내
    setTimeout(() => { if (state.screen === "outdoor") updateNavUI(); }, 3000);
  }

  // GPS가 아직 없으면 직전 지점에 있다고 가정해서라도 방향을 보여 줌
  function guessPos() {
    if (nav.pos) return nav.pos;
    const prev = RT().outdoor[state.outIdx - 1];
    return prev ? { lat: prev.lat, lng: prev.lng, guessed: true } : null;
  }
  function paintArrow() {
    if (state.screen !== "outdoor") return;
    const step = RT().outdoor[state.outIdx], arrow = $("#arrow"); if (!step || !arrow) return;
    const compassOk = nav.heading != null && Date.now() - nav.headingAt < 4000;
    const ring = $("#ring");
    if (ring) {
      const target = compassOk ? -nav.heading : 0;
      nav.ringDeg = nav.ringDeg == null ? target : nav.ringDeg + norm180(target - nav.ringDeg);
      ring.style.transform = `rotate(${nav.ringDeg}deg)`;
    }
    const p = guessPos();
    if (!p) return;
    const b = bearing(p, step);
    const rel = compassOk ? norm180(b - nav.heading) : norm180(b);
    // 359°→0° 를 넘을 때 한 바퀴 거꾸로 도는 것 방지: 각도를 누적
    nav.arrowDeg = nav.arrowDeg == null ? rel : nav.arrowDeg + norm180(rel - nav.arrowDeg);
    arrow.style.transform = `rotate(${nav.arrowDeg}deg)`;
    const st = $("#compassState");
    if (st) {
      st.innerHTML = compassOk ? "🧭 휴대폰 방향을 따라 돌아요"
        : nav.compassLive ? "🧭 방향 센서 연결 중…"
        : perm.compass === "denied" ? (isIOS ? "🧭 방향 센서가 꺼져 있어요<br><small>설정 → 앱 → Safari → ‘동작 및 방향 접근’ 켜고 새로고침</small>" : "🧭 방향 센서가 꺼져 있어요 — 위쪽이 북쪽")
        : "🧭 방향 센서 꺼짐 — 위쪽이 북쪽";
      st.classList.toggle("on", compassOk);
    }
    return rel;
  }
  function updateNavUI() {
    if (state.screen !== "outdoor") return;
    const step = RT().outdoor[state.outIdx]; if (!step) return;
    const arrow = $("#arrow"); if (!arrow) return;
    const rel = paintArrow();
    if (!nav.pos) {
      $("#dirWord").textContent = guessPos() ? "위치 찾는 중 · 대략 이쪽이에요" : "위치를 찾는 중…";
      return;
    }
    updateMiniMap(step);
    const d = distanceM(nav.pos, step);
    const compassOk = nav.heading != null && Date.now() - nav.headingAt < 4000;
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
    if (state.outIdx >= RT().outdoor.length) { state.inIdx = 0; go(RT().indoor.length ? "indoor" : "done"); }
    else renderOutdoor();
  }

  // ───────────────────────── 화면 3: 실내 한 걸음 안내 ─────────────────────────
  function renderIndoor() {
    const i = state.inIdx, step = RT().indoor[i];
    if (!step) return go("done");
    setStep(`3. 병원 안 ${i + 1}/${RT().indoor.length}`, `창구까지 ${RT().indoor.length - i}단계`);
    main.innerHTML = `
      <div class="progress">${RT().indoor.map((_, k) => `<i class="${k <= i ? "on" : ""}"></i>`).join("")}</div>
      <section class="card">
        <p class="muted">지금 할 일 한 가지 ${step.verified ? "" : '<span class="badge">현장 확인 전</span>'}</p>
        <p class="big">${step.screen}</p>
      </section>
      <section class="sign">🪧 ${step.sign}</section>
      <section class="card"><p class="muted">소리를 꺼도 화면 글씨와 버튼만으로 끝까지 갈 수 있어요. 마지막으로 확인한 곳을 기억해 둡니다.</p></section>`;
    dock.replaceChildren(
      btn(i === RT().indoor.length - 1 ? "✅ 창구에 도착했어요" : "👍 했어요 · 다음", "btn-xl btn-primary", () => { state.inIdx++; save(); vibrate(60); renderIndoor(); }),
      row(replayBtn(), btn("⬅ 이전 단계", "btn-light", () => { if (state.inIdx > 0) { state.inIdx--; save(); renderIndoor(); } else { state.outIdx = RT().outdoor.length - 1; go("outdoor"); } })),
      btn("🙋 직원에게 보여줄 도움 문장 크게 켜기", "btn-xl btn-help", openHelp)
    );
    speak(step.voice);
  }

  function renderDone() {
    setStep("도착!", "수고하셨어요");
    if (!isPreset()) {
      main.innerHTML = `<section class="card"><p class="big">${esc(state.dest.name)}에<br>잘 도착하셨어요. 👏</p><p style="margin-top:12px">건물 간판의 이름이 맞는지 한 번 더 확인하세요.</p></section>`;
      dock.replaceChildren(btn("🗺 다른 곳 고르기", "btn-xl btn-light", () => go("pick")), row(replayBtn(), helpBtn()));
      return speak(`${state.dest.name}에 잘 도착하셨어요. 수고 많으셨어요.`);
    }
    main.innerHTML = `<section class="card"><p class="big">처음오신 창구에<br>잘 도착하셨어요. 👏</p>
      <p style="margin-top:12px">번호가 불리면 창구에서 <b>“오늘 예약하고 처음 왔어요”</b> 라고 말씀하세요.</p></section>`;
    dock.replaceChildren(btn("🩺 진료 받을 때 말씀 받아 적기", "btn-xl btn-talk", openDoctor), row(btn("🏠 처음 화면으로", "btn-light", () => resetAll()), helpBtn()));
    speak("처음오신 창구에 잘 도착하셨어요. 정말 수고 많으셨어요. 번호가 불리면 창구에서, 오늘 예약하고 처음 왔다고 말씀하세요.");
  }

  // ───────────────────────── 권한 켜기 (위치 · 마이크 · 방향) ─────────────────────────
  const UA = navigator.userAgent;
  const isAndroid = /Android/i.test(UA);
  const isIOS = /iPhone|iPad|iPod/i.test(UA) || (!isAndroid && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const inApp = /KAKAOTALK|NAVER\(|Instagram|FBAN|FBAV|Line\/|DaumApps|everytimeApp|SamsungBrowser\/.*CrossApp/i.test(UA);
  const perm = { loc: "unknown", mic: "unknown", compass: "unknown" };

  async function queryPerm(name) {
    try { return (await navigator.permissions.query({ name })).state; } catch { return "unknown"; }
  }
  function requestLocation() {
    return new Promise(res => {
      if (!("geolocation" in navigator)) return res("unsupported");
      if (!isSecureContext) return res("insecure");
      navigator.geolocation.getCurrentPosition(
        p => { nav.pos = { lat: p.coords.latitude, lng: p.coords.longitude }; nav.acc = p.coords.accuracy; res("granted"); },
        e => res(e.code === 1 ? "denied" : "error"),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
    });
  }
  async function requestMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return SR ? "unknown" : "unsupported";
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: true });
      st.getTracks().forEach(t => t.stop());
      return "granted";
    } catch (e) { return e && (e.name === "NotAllowedError" || e.name === "SecurityError") ? "denied" : "error"; }
  }
  async function requestCompass() {
    if (typeof DeviceOrientationEvent === "undefined") return "unsupported";
    if (typeof DeviceOrientationEvent.requestPermission !== "function") return "granted";
    try { const r = await DeviceOrientationEvent.requestPermission(); nav.sensorAsked = true; return r === "granted" ? "granted" : "denied"; }
    catch { return "denied"; }
  }
  const PERM_LABEL = { granted: "✅ 켜짐", denied: "❌ 꺼짐", prompt: "⏳ 아직", unknown: "⏳ 아직", error: "⚠️ 다시 시도", unsupported: "— 지원 안 함", insecure: "⚠️ https 필요" };
  function fixGuide(kind) {
    const what = kind === "loc" ? "위치" : "마이크";
    if (inApp) return `카카오톡·네이버 같은 앱 안에서는 ${what}가 안 될 수 있어요. 오른쪽 위 ⋮ 또는 공유 버튼에서 <b>‘다른 브라우저로 열기’</b>를 눌러 ${isIOS ? "Safari" : "Chrome"}로 열어 주세요.`;
    if (isIOS) return kind === "loc"
      ? `① 아이폰 <b>설정 → 개인정보 보호 및 보안 → 위치 서비스</b>를 켜고, 아래쪽 <b>Safari 웹 사이트 → ‘앱을 사용하는 동안’</b>으로 바꾸세요.<br>② Safari 주소창 왼쪽 <b>‘가가’(aA) 버튼 → 웹 사이트 설정 → 위치 ‘허용’</b>.<br>③ 이 화면으로 돌아와 다시 눌러 주세요.`
      : `① Safari 주소창 왼쪽 <b>‘가가’(aA) 버튼 → 웹 사이트 설정 → 마이크 ‘허용’</b>.<br>② 그래도 안 되면 <b>설정 → Safari → 마이크 → 허용</b>, 그리고 <b>설정 → Siri → ‘Siri에게 말하기’</b>(받아쓰기)를 켜 주세요.`;
    if (isAndroid) return kind === "loc"
      ? `① 화면 위에서 아래로 쓸어내려 <b>‘위치’</b>를 켜세요.<br>② Chrome 주소창 왼쪽 <b>설정(⚙ 또는 자물쇠) 버튼 → 권한 → 위치 ‘허용’</b>.<br>③ 이 화면으로 돌아와 다시 눌러 주세요.`
      : `Chrome 주소창 왼쪽 <b>설정(⚙ 또는 자물쇠) 버튼 → 권한 → 마이크 ‘허용’</b>을 눌러 주세요.`;
    return `브라우저 주소창 왼쪽 자물쇠 버튼을 눌러 ${what}를 ‘허용’으로 바꿔 주세요.`;
  }
  async function renderPerm() {
    setStep("시작 준비", "권한 켜기");
    perm.loc = perm.loc === "unknown" ? await queryPerm("geolocation") : perm.loc;
    perm.mic = perm.mic === "unknown" ? await queryPerm("microphone") : perm.mic;
    const needCompass = typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function";
    const item = (k, icon, title, desc, show = true) => !show ? "" : `
      <div class="slot ${perm[k] === "granted" ? "" : "missing"}">
        <div><div class="v">${icon} ${title}</div><div class="k">${desc}</div></div>
        <button class="edit" data-perm="${k}">${perm[k] === "granted" ? "✅ 켜짐" : "켜기"}</button>
      </div>
      ${perm[k] === "denied" || perm[k] === "error" || perm[k] === "insecure" ? `<div class="sign" style="font-size:18px">${perm[k] === "insecure" ? "https 주소로 열어야 해요." : fixGuide(k)}</div>` : ""}`;
    main.innerHTML = `
      <section class="card"><p class="big">길 안내를 하려면<br>두 가지를 켜 주세요.</p>
        <p class="muted" style="margin-top:8px">버튼을 누르면 휴대폰이 물어봐요. <b>‘허용’</b>을 눌러 주세요.</p></section>
      ${inApp ? `<div class="sign" style="font-size:18px">⚠️ ${fixGuide("loc")}</div>` : ""}
      <section class="slots">
        ${item("loc", "📍", "위치(GPS)", "어디로 걸어가야 할지 알려 드려요")}
        ${item("mic", "🎙", "마이크", "말로 병원 이름을 알려 주실 수 있어요")}
        ${item("compass", "🧭", "방향 센서", "휴대폰이 향한 쪽으로 화살표를 돌려요", needCompass)}
      </section>
      ${!SR ? `<p class="muted">이 브라우저는 말 알아듣기를 지원하지 않아요. 버튼으로도 모두 쓸 수 있어요.</p>` : ""}
      <p class="muted">이름·음성 녹음은 저장하지 않아요. 위치는 길 안내에만 쓰고 어디에도 보내지 않아요.</p>`;
    main.querySelectorAll("[data-perm]").forEach(b => b.onclick = async () => {
      const k = b.dataset.perm; b.textContent = "확인 중…";
      perm[k] = k === "loc" ? await requestLocation() : k === "mic" ? await requestMic() : await requestCompass();
      if (k === "compass" && perm[k] === "granted") startCompass();
      speak(perm[k] === "granted" ? ({ loc: "위치가 켜졌어요.", mic: "마이크가 켜졌어요.", compass: "방향 센서가 켜졌어요." })[k]
        : "아직 꺼져 있어요. 화면의 방법대로 켜 주세요.");
      renderPerm();
    });
    const allOn = perm.loc === "granted" && (perm.mic === "granted" || !SR);
    const all = btn("✨ 한 번에 모두 켜기", "btn-xl btn-talk", async () => {
      all.textContent = "확인 중…";
      const cp = needCompass ? requestCompass() : null;   // 아이폰은 누른 순간에 물어봐야 해서 맨 먼저
      if (cp) { perm.compass = await cp; if (perm.compass === "granted") startCompass(); }
      perm.loc = await requestLocation();
      perm.mic = await requestMic();
      speak(perm.loc === "granted" && perm.mic === "granted" ? "모두 켜졌어요. 다음 버튼을 눌러 주세요." : "꺼진 것이 있어요. 화면의 방법대로 켜 주세요.");
      renderPerm();
    });
    const next = btn(allOn ? "다음 ▶" : "나중에 할게요 ▶", allOn ? "btn-xl btn-primary" : "btn-light", () => { store.set("permDone", true); go(state.slots.hospital ? "pick" : "talk"); });
    dock.replaceChildren(...(allOn ? [next] : [all, row(replayBtn(), next)]));
    if (!renderPerm.spoken) { renderPerm.spoken = true; speak("길 안내를 하려면 위치와 마이크를 켜야 해요. 노란 버튼을 누르고, 휴대폰이 물어보면 허용을 눌러 주세요."); }
  }

  // ───────────────────────── 지도에서 목적지 고르기 ─────────────────────────
  const maps = { pick: null, mini: null, miniMe: null, miniLine: null, miniAt: 0 };
  const MIGEUM = [37.35015, 127.10905];
  const hasLeaflet = () => typeof window.L !== "undefined";
  function tiles(m) {
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(m);
  }
  const bigIcon = (emoji, cls = "") => hasLeaflet() ? L.divIcon({ className: "pin " + cls, html: `<span>${emoji}</span>`, iconSize: [48, 48], iconAnchor: [24, 44] }) : null;
  const meIcon = () => L.divIcon({ className: "me-dot", html: "<span></span>", iconSize: [26, 26], iconAnchor: [13, 13] });

  async function geocode(q) {
    const near = nav.pos || { lat: MIGEUM[0], lng: MIGEUM[1] };
    const vb = [near.lng - 0.3, near.lat + 0.25, near.lng + 0.3, near.lat - 0.25].join(",");
    const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=kr&accept-language=ko&limit=6&viewbox=${vb}&q=${encodeURIComponent(q)}`;
    const r = await fetch(u, { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error("search");
    const list = await r.json();
    return list.map(x => ({ name: x.name || x.display_name.split(",")[0], addr: x.display_name.split(",").slice(1, 4).join(",").trim(), lat: +x.lat, lng: +x.lon }))
      .sort((a, b) => distanceM(near, a) - distanceM(near, b));
  }
  async function reverse(lat, lng) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=ko&zoom=18&lat=${lat}&lon=${lng}`);
      const j = await r.json();
      return j.name || (j.address && (j.address.amenity || j.address.building || j.address.road)) || "고른 곳";
    } catch { return "고른 곳"; }
  }
  function cleanQuery(t) {
    return t.replace(/(에|으로|로)?\s*(가고\s*싶어요|가고\s*싶어|갈래요|가요|가야\s*돼요|가야\s*해요|가려고요|가려고\s*해요|가 주세요|찾아\s*줘|찾아\s*주세요)[.!?]?$/, "").replace(/[.!?]$/, "").trim();
  }

  function renderPick() {
    setStep("2. 어디로 갈까요?", "지도에서 고르기");
    let picked = isPreset() ? null : { ...state.dest };
    main.innerHTML = `
      <section class="card">
        <p class="big" style="font-size:26px">지도를 눌러 고르거나,<br>이름으로 찾으세요.</p>
      </section>
      <form id="searchForm" class="search" role="search">
        <input id="q" type="search" enterkeyhint="search" placeholder="예) 분당차병원, 정자역" autocomplete="off">
        <button class="btn btn-primary" type="submit">찾기</button>
      </form>
      <div id="results" class="results"></div>
      <div id="pickMap" class="map" aria-label="목적지를 고르는 지도"></div>
      <section class="card" id="pickInfo"><p class="muted">아직 고르지 않았어요.</p></section>
      <button class="btn btn-light" id="presetBtn">🏥 분당서울대병원 (미금역에서 출발 · 확인된 경로)</button>
      <button class="btn btn-light" id="nearBtn">📍 내 주변 병원 목록에서 고르기</button>`;
    $("#nearBtn").onclick = () => openNear("hosp");

    const startBtn = btn("🧭 여기로 길 안내 시작", "btn-xl btn-primary", () => {
      if (!picked) return speak("먼저 갈 곳을 골라 주세요.");
      state.dest = picked; state.outIdx = 0; nav.pos = state.demo ? null : nav.pos; save(); go("outdoor");
    });
    const voiceBtn = btn("🎙 말로 찾기", "btn-talk", function () {
      listen(t => { const q = cleanQuery(t); $("#q").value = q; doSearch(q); }, this);
    });
    dock.replaceChildren(startBtn, row(voiceBtn, replayBtn()));

    $("#presetBtn").onclick = () => { state.dest = null; state.outIdx = 0; save(); go("outdoor"); };

    function showPicked() {
      const box = $("#pickInfo");
      if (!picked) return;
      const d = nav.pos ? distanceM(nav.pos, picked) : null;
      const far = d != null && d > 1500;
      box.innerHTML = `<p class="muted">고른 곳</p><p class="big" style="font-size:26px">📍 ${esc(picked.name)}</p>
        ${d != null ? `<p style="margin:6px 0 0">지금 여기서 <b>${distText(d)}</b>${far ? " — 걸어가기엔 멀어요. 버스나 택시를 타고 가까이 가신 뒤 안내를 받으세요." : ""}</p>` : ""}`;
      speak(`${picked.name}을 골랐어요.${d != null ? ` 여기서 ${distSpeech(d).replace(" 남았어요", "")} 거리예요.` : ""} 맞으면 길 안내 시작 버튼을 눌러 주세요.`.replace("바로 앞이에요 거리예요", "바로 앞이에요"));
    }
    function choose(p) {
      picked = p;
      if (maps.pick) {
        if (maps.pickMarker) maps.pickMarker.setLatLng([p.lat, p.lng]);
        else maps.pickMarker = L.marker([p.lat, p.lng], { icon: bigIcon("📍", "dest") }).addTo(maps.pick);
        maps.pick.setView([p.lat, p.lng], Math.max(maps.pick.getZoom(), 16));
      }
      showPicked();
    }
    async function doSearch(q) {
      const res = $("#results");
      if (!q) return;
      res.innerHTML = `<p class="muted">찾는 중…</p>`;
      try {
        const list = await geocode(q);
        if (!list.length) { res.innerHTML = `<p class="muted">‘${esc(q)}’을(를) 못 찾았어요. 지도를 직접 눌러 골라 주세요.</p>`; return speak("찾지 못했어요. 지도를 직접 눌러 골라 주세요."); }
        res.innerHTML = "";
        list.slice(0, 4).forEach(p => {
          const b = btn(`<span style="text-align:left;flex:1"><b>${esc(p.name)}</b><br><small class="muted">${esc(p.addr)}${nav.pos ? " · " + distText(distanceM(nav.pos, p)) : ""}</small></span>`, "btn-light result", () => { res.innerHTML = ""; choose(p); });
          res.append(b);
        });
        speak(`${list.length > 1 ? "몇 곳을 찾았어요. 가실 곳을 눌러 주세요." : "찾았어요. 눌러 주세요."}`);
      } catch { res.innerHTML = `<p class="muted">인터넷 연결을 확인해 주세요.</p>`; }
    }
    $("#searchForm").onsubmit = (e) => { e.preventDefault(); $("#q").blur(); doSearch($("#q").value.trim()); };

    if (!hasLeaflet()) { $("#pickMap").innerHTML = `<p class="muted" style="padding:16px">지도를 불러오지 못했어요. 이름으로 찾아 주세요.</p>`; }
    else {
      const center = picked ? [picked.lat, picked.lng] : nav.pos ? [nav.pos.lat, nav.pos.lng] : MIGEUM;
      const m = maps.pick = L.map("pickMap", { zoomControl: true, attributionControl: true }).setView(center, 16);
      maps.pickMarker = null; tiles(m);
      if (nav.pos) maps.pickMe = L.marker([nav.pos.lat, nav.pos.lng], { icon: meIcon(), interactive: false }).addTo(m);
      m.on("click", async (e) => {
        const p = { name: "고른 곳", lat: e.latlng.lat, lng: e.latlng.lng };
        choose(p);
        p.name = await reverse(p.lat, p.lng);
        if (picked === p) showPicked();
      });
      if (picked) choose(picked);
      // 내 위치 찾기
      if (!nav.pos && !state.demo) requestLocation().then(r => {
        perm.loc = r;
        if (r === "granted" && maps.pick) {
          maps.pickMe = L.marker([nav.pos.lat, nav.pos.lng], { icon: meIcon(), interactive: false }).addTo(maps.pick);
          if (!picked) maps.pick.setView([nav.pos.lat, nav.pos.lng], 16);
        }
      });
    }

    // 말한 병원 이름이 있으면 바로 찾아 줌
    const h = state.slots.hospital;
    if (!picked && h && !/분당서울대/.test(h)) { $("#q").value = h; doSearch(h); }
    else if (!picked) speak("어디로 가실지 골라 주세요. 지도를 누르거나, 이름으로 찾으시면 돼요. 분당서울대병원은 아래 버튼을 누르세요.");
  }

  // 길 안내 화면 아래 작은 지도: 나와 목적지, 그리고 직선
  function makeMiniMap(step) {
    if (!hasLeaflet()) { $("#miniMap").remove(); return; }
    const m = maps.mini = L.map("miniMap", { zoomControl: false, attributionControl: true, dragging: true }).setView([step.lat, step.lng], 16);
    tiles(m);
    L.marker([step.lat, step.lng], { icon: bigIcon(step.type === "bus" ? "🚏" : "📍", "dest") }).addTo(m);
    maps.miniMe = null; maps.miniLine = null; maps.miniAt = 0; maps.miniFitAt = 0;
    setTimeout(() => m.invalidateSize(), 250);
  }
  function updateMiniMap(step) {
    if (!maps.mini || !nav.pos) return;
    const now = Date.now(); if (now - maps.miniAt < 1500) return; maps.miniAt = now;
    const me = [nav.pos.lat, nav.pos.lng], to = [step.lat, step.lng];
    if (!maps.miniMe) maps.miniMe = L.marker(me, { icon: meIcon(), interactive: false }).addTo(maps.mini); else maps.miniMe.setLatLng(me);
    if (!maps.miniLine) maps.miniLine = L.polyline([me, to], { color: "#0b5d4b", weight: 5, dashArray: "8 8" }).addTo(maps.mini); else maps.miniLine.setLatLngs([me, to]);
    // 지도는 가끔만 다시 맞춤 (타일이 다 그려질 시간을 줌)
    const b = L.latLngBounds([me, to]);
    if (now - maps.miniFitAt > 8000 || !maps.mini.getBounds().contains(b)) {
      maps.miniFitAt = now;
      maps.mini.fitBounds(b.pad(0.3), { maxZoom: 18, animate: false });
    }
  }

  // ───────────────────────── 진료 말씀 받아 적고 쉽게 요약 ─────────────────────────
  // 개인정보: 받아 적은 글과 요약은 이 화면에만 있고 저장하거나 서버에 남기지 않습니다. 소리 파일도 만들지 않습니다.
  const doc = { phase: "intro", finals: [], interim: "", rec: null, wantRec: false, startedAt: 0, timer: null, summary: null, back: "talk" };

  // 어려운 의학 용어 → 쉬운 말
  const EASY_WORDS = [
    [/고혈압/g, "고혈압(혈압이 높은 병)"], [/저혈압/g, "저혈압(혈압이 낮은 병)"], [/당뇨(병)?/g, "당뇨(피 속 당이 높은 병)"],
    [/고지혈증|이상지질혈증/g, "고지혈증(피에 기름이 많은 병)"], [/골다공증/g, "골다공증(뼈가 약해지는 병)"],
    [/관절염/g, "관절염(뼈마디 염증)"], [/협심증/g, "협심증(심장 혈관이 좁아진 병)"], [/부정맥/g, "부정맥(심장이 불규칙하게 뛰는 병)"],
    [/공복/g, "빈속"], [/금식/g, "금식(아무것도 먹지 않기)"], [/식후\s*(\d+|삼십|30)\s*분/g, "밥 먹고 $1분 뒤"], [/식후에?/g, "밥 먹고 나서"], [/식전에?/g, "밥 먹기 전에"],
    [/취침\s*전/g, "자기 전"], [/복용/g, "드시기"], [/투약|투여/g, "약 쓰기"], [/처방/g, "약 받기(처방)"],
    [/경과\s*관찰/g, "지켜보기"], [/추적\s*검사/g, "다시 하는 검사"], [/재진/g, "다시 오는 진료"], [/외래/g, "외래 진료"],
    [/부작용/g, "부작용(약 때문에 생기는 불편함)"], [/염증/g, "염증(붓고 열나는 것)"], [/수치/g, "수치(검사 숫자)"],
    [/혈액\s*검사|채혈/g, "피 검사"], [/소변\s*검사/g, "소변 검사"], [/영상\s*검사/g, "사진 찍는 검사"],
    [/양성/g, "양성"], [/음성/g, "음성"], [/정상\s*범위/g, "정상"], [/내원/g, "병원에 오기"], [/입원/g, "입원(병원에서 지내기)"],
    [/시술/g, "시술(간단한 치료)"], [/수술/g, "수술"], [/진통제/g, "진통제(아픈 것 줄이는 약)"], [/항생제/g, "항생제(세균 잡는 약)"],
    [/소염제/g, "소염제(붓기 줄이는 약)"], [/이뇨제/g, "이뇨제(소변 잘 나오게 하는 약)"], [/혈압약/g, "혈압약"]
  ];
  const DOC_CATS = [
    { key: "medicine", icon: "💊", title: "약 드시는 법", re: /약|복용|드세요|드시|먹|알씩|정씩|캡슐|처방|연고|바르|주사|파스|식후|식전|자기\s*전|아침|저녁|하루\s*(한|두|세|네|\d)/ },
    { key: "nextVisit", icon: "📅", title: "다음에 오실 때", re: /다음|예약|주\s*뒤|주\s*후|개월|달\s*뒤|다시\s*오|재진|외래|날짜|오세요|오시면/ },
    { key: "tests", icon: "🧪", title: "검사", re: /검사|혈액|피\s*검사|채혈|엑스레이|x-?ray|씨티|ct|mri|엠알아이|초음파|내시경|소변|심전도|금식/i },
    { key: "caution", icon: "⚠️", title: "꼭 조심하세요", re: /하지\s*마|마세요|피하|금지|조심|주의|안\s*돼|안\s*됩|술|담배|짜게|무리|넘어지|응급|바로\s*오|119|열이\s*나|숨이|어지러|붓|피가\s*나|부작용/ },
    { key: "diagnosis", icon: "🩺", title: "선생님 말씀 (몸 상태)", re: /진단|병|염|증|암|혈압|당뇨|수치|결과|괜찮|정상|나빠|좋아|좋아졌|문제|상태|때문/ }
  ];
  function splitKo(text) {
    return text
      .replace(/\s+/g, " ")
      .replace(/(습니다|니다|세요|에요|예요|어요|아요|해요|죠|고요|거든요|네요|군요|래요|대요|요)(\s)/g, "$1.$2")
      .split(/(?<=[.!?])\s+/).map(s => s.replace(/[.]+$/, "").trim()).filter(s => s.length > 3);
  }
  function easy(s) { return EASY_WORDS.reduce((t, [re, to]) => t.replace(re, to), s); }
  function localSummary(text) {
    const out = { oneLine: "", diagnosis: [], medicine: [], nextVisit: [], tests: [], caution: [], other: [] };
    const seen = new Set();
    splitKo(text).forEach(s => {
      const k = s.replace(/\s/g, ""); if (seen.has(k)) return; seen.add(k);
      // 한 문장이 여러 칸에 맞으면 더 중요한 칸(조심 > 약 > 다음 진료 > 검사 > 몸 상태) 하나에만 넣음
      const order = ["caution", "medicine", "nextVisit", "tests", "diagnosis"];
      let cat = order.find(c => DOC_CATS.find(d => d.key === c).re.test(s));
      // "검사 결과 보니까…" 처럼 결과를 설명하는 말은 몸 상태로
      if (cat === "tests" && /결과|보니까|나왔|상태/.test(s) && !/검사\s*(하|할|받|해)/.test(s)) cat = "diagnosis";
      (out[cat || "other"]).push(easy(s));
    });
    const bits = [];
    if (out.diagnosis.length) bits.push("몸 상태 설명");
    if (out.medicine.length) bits.push("약 드시는 법");
    if (out.tests.length) bits.push("검사");
    if (out.nextVisit.length) bits.push("다음 진료");
    if (out.caution.length) bits.push("조심할 점");
    out.oneLine = bits.length ? `오늘 선생님이 ${bits.join(", ")}을 말씀하셨어요.` : "받아 적은 내용을 정리했어요.";
    out.other = out.other.slice(0, 4);
    return out;
  }
  async function summarize(text) {
    if (server.ai) {
      try {
        const r = await fetch("api/summary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
        if (r.ok) { const j = await r.json(); j.byAI = true; return j; }
      } catch {}
    }
    return localSummary(text);
  }
  function summarySpeech(s) {
    const parts = [s.oneLine];
    DOC_CATS.slice().reverse().forEach(c => { if (s[c.key] && s[c.key].length) parts.push(`${c.title.replace(/\s*\(.*\)/, "")}. ${s[c.key].join(". ")}.`); });
    return parts.join(" ").replace(/\(([^)]*)\)/g, ", $1,");
  }
  const docText = () => (doc.finals.join(" ") + " " + doc.interim).trim();

  function docStartRec() {
    if (!SR || !isSecureContext) { doc.phase = "type"; return renderDoctor(); }
    stopSpeaking();
    doc.wantRec = true;
    const startOne = () => {
      if (!doc.wantRec) return;
      const rec = new SR();
      rec.lang = "ko-KR"; rec.continuous = true; rec.interimResults = true;
      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) doc.finals.push(r[0].transcript.trim()); else interim += r[0].transcript;
        }
        doc.interim = interim; paintLive();
      };
      rec.onerror = (e) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture") {
          doc.wantRec = false; doc.micError = e.error;
        }
      };
      // 휴대폰은 조용하면 듣기를 멈추므로, "다 들었어요"를 누를 때까지 다시 켭니다
      rec.onend = () => {
        if (doc.interim) { doc.finals.push(doc.interim.trim()); doc.interim = ""; }
        doc.rec = null;
        if (doc.wantRec) setTimeout(startOne, 250);
        else if (doc.micError) { doc.phase = "type"; renderDoctor(); }
      };
      doc.rec = rec;
      try { rec.start(); } catch { doc.wantRec = false; doc.phase = "type"; renderDoctor(); }
    };
    doc.phase = "rec"; doc.startedAt = Date.now(); doc.micError = "";
    renderDoctor();
    startOne();
    clearInterval(doc.timer);
    doc.timer = setInterval(() => { const t = $("#recTime"); if (t) { const s = Math.floor((Date.now() - doc.startedAt) / 1000); t.textContent = `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, "0")}초`; } }, 1000);
    if (navigator.wakeLock) navigator.wakeLock.request("screen").then(l => doc.wake = l).catch(() => {});
  }
  function docStopRec() {
    doc.wantRec = false; clearInterval(doc.timer);
    if (doc.rec) { try { doc.rec.stop(); } catch {} }
    if (doc.wake) { doc.wake.release().catch(() => {}); doc.wake = null; }
  }
  function paintLive() {
    const el = $("#liveText"); if (!el) return;
    el.innerHTML = esc(doc.finals.join(" ")) + (doc.interim ? ` <span class="interim">${esc(doc.interim)}</span>` : "") || '<span class="muted">말씀을 기다리는 중…</span>';
    el.scrollTop = el.scrollHeight;
  }
  async function docFinish() {
    docStopRec();
    await new Promise(r => setTimeout(r, 400));
    const text = docText();
    if (!text) { speak("받아 적은 말씀이 없어요. 다시 해 볼까요?"); doc.phase = "intro"; return renderDoctor(); }
    doc.phase = "summary"; doc.summary = null; renderDoctor();
    doc.summary = await summarize(text);
    renderDoctor();
  }

  function renderDoctor() {
    setStep("🩺 진료 내용 쉽게 듣기", doc.phase === "rec" ? "받아 적는 중" : doc.phase === "summary" ? "쉬운 말 정리" : "");
    const backBtn = btn("⬅ 돌아가기", "btn-light", () => { docStopRec(); go(doc.back || "talk"); });

    if (doc.phase === "intro") {
      main.innerHTML = `
        <section class="card">
          <p class="big">선생님 말씀을 받아 적어<br>쉬운 말로 정리해 드려요.</p>
          <p class="muted" style="margin-top:10px">진료실에서 휴대폰을 책상 위에 올려 두세요.</p>
        </section>
        <section class="help-mini">
          <p class="help-small">선생님께 먼저 보여 드리세요</p>
          <p class="help-q">“선생님 말씀을 휴대폰으로 받아 적어서 쉽게 다시 보려고 해요. 괜찮을까요?”</p>
        </section>
        <p class="muted">🔒 소리 파일은 만들지 않고, 받아 적은 글은 이 화면을 닫으면 사라져요.</p>`;
      dock.replaceChildren(
        btn("🎙 받아 적기 시작", "btn-xl btn-talk", docStartRec),
        row(btn("⌨️ 직접 쓰기", "btn-light", () => { doc.phase = "type"; renderDoctor(); }), backBtn)
      );
      return speak("선생님 말씀을 받아 적어서, 쉬운 말로 정리해 드릴게요. 먼저 선생님께 화면을 보여 드리고, 괜찮다고 하시면 노란 버튼을 눌러 주세요.");
    }

    if (doc.phase === "rec") {
      main.innerHTML = `
        <section class="card rec-card">
          <p class="rec-dot">● 받아 적는 중 <span id="recTime">0분 00초</span></p>
          <div id="liveText" class="live-text"></div>
        </section>
        <p class="muted">말씀이 끝나면 아래 빨간 버튼을 눌러 주세요.</p>`;
      paintLive();
      dock.replaceChildren(btn("⏹ 다 들었어요 · 정리하기", "btn-xl btn-stop", docFinish), row(btn("✖ 취소", "btn-light", () => { docStopRec(); doc.finals = []; doc.interim = ""; doc.phase = "intro"; renderDoctor(); })));
      return;
    }

    if (doc.phase === "type") {
      main.innerHTML = `
        <section class="card">
          ${doc.micError ? `<p class="muted">바로 받아 적기가 안 돼서 다른 방법으로 할게요.</p>` : ""}
          <p class="big" style="font-size:24px">아래 칸을 누르고 키보드의 <span class="kbd">🎤</span> 버튼을 누른 채로 두면, 선생님 말씀이 글로 적혀요.</p>
          <p class="muted" style="margin-top:6px">약 봉투나 안내문 내용을 써도 돼요.</p>
        </section>
        <textarea id="docBox" rows="7" placeholder="예) 혈압약은 하루 한 번 아침 식후에 드세요. 다음 주에 피 검사하니까 그날은 공복으로 오세요.">${esc(docText())}</textarea>`;
      const box = $("#docBox");
      dock.replaceChildren(
        btn("📝 쉬운 말로 정리하기", "btn-xl btn-primary", () => { doc.finals = [box.value]; doc.interim = ""; docFinish(); }),
        row(btn("🎙 바로 받아 적기", "btn-light", docStartRec), backBtn)
      );
      return;
    }

    // summary
    const s = doc.summary;
    if (!s) { main.innerHTML = `<section class="card"><p class="big">정리하는 중이에요…</p></section>`; dock.replaceChildren(); return; }
    const sec = (c) => (s[c.key] && s[c.key].length) ? `
      <section class="card sum-${c.key}">
        <p class="sum-title">${c.icon} ${c.title}</p>
        <ul class="sum-list">${s[c.key].map(x => `<li>${esc(x)}</li>`).join("")}</ul>
      </section>` : "";
    main.innerHTML = `
      <section class="card"><p class="big" style="font-size:26px">${esc(s.oneLine || "")}</p></section>
      ${["caution", "medicine", "nextVisit", "tests", "diagnosis"].map(k => sec(DOC_CATS.find(d => d.key === k))).join("")}
      ${s.other && s.other.length ? sec({ key: "other", icon: "📝", title: "그 밖의 말씀" }) : ""}
      <p class="sign" style="font-size:18px">ℹ️ ${s.byAI ? "AI가" : "휴대폰이 자동으로"} 정리한 거라 틀릴 수 있어요. <b>약과 날짜는 꼭 약 봉투와 안내문, 또는 선생님께 다시 확인하세요.</b></p>
      <details class="card"><summary>받아 적은 말씀 전체 보기</summary><p style="margin:10px 0 0;font-size:19px">${esc(docText())}</p></details>`;
    const speakAll = () => speak(summarySpeech(s), { force: true });
    const shareBtn = btn("📤 가족에게 보내기", "btn-light", async () => {
      const txt = `[병원한걸음 진료 메모]\n${s.oneLine}\n` + ["caution", "medicine", "nextVisit", "tests", "diagnosis", "other"]
        .filter(k => s[k] && s[k].length).map(k => { const c = DOC_CATS.find(d => d.key === k) || { icon: "📝", title: "그 밖의 말씀" }; return `\n${c.icon} ${c.title}\n- ${s[k].join("\n- ")}`; }).join("\n")
        + "\n\n※ 자동 정리라 틀릴 수 있어요. 약·날짜는 꼭 다시 확인하세요.";
      try {
        if (navigator.share) await navigator.share({ title: "진료 메모", text: txt });
        else { await navigator.clipboard.writeText(txt); speak("복사했어요. 문자나 카카오톡에 붙여 넣어 보내세요.", { force: true }); }
      } catch {}
    });
    dock.replaceChildren(
      btn("🔊 정리한 내용 들려주기", "btn-xl btn-primary", speakAll),
      row(shareBtn, btn("🗑 지우고 새로", "btn-light", () => { doc.finals = []; doc.interim = ""; doc.summary = null; doc.phase = "intro"; renderDoctor(); }))
    );
    main.append(backBtn);
    speakAll();
  }
  function openDoctor() {
    if (state.screen !== "doctor") doc.back = state.screen;
    if (doc.phase === "rec") doc.phase = "intro";
    go("doctor");
  }

  // ───────────────────────── 119 응급 전화 ─────────────────────────
  // 전화 버튼은 휴대폰 전화 앱을 119가 입력된 상태로 엽니다 (통화는 어르신이 직접 누름 → 실수로 걸리지 않음).
  async function openSOS() {
    stopSpeaking();
    const s = state.slots, where =
      state.screen === "indoor" ? "분당서울대병원 1동 1층이에요." :
      state.screen === "outdoor" ? `${RT().outdoor[state.outIdx] ? RT().outdoor[state.outIdx].place : "병원"} 가는 길이에요.` : "";
    $("#sosScript").innerHTML = [
      "① <b>어디인지</b>: 아래 위치를 읽어 주세요." + (where ? "<br>　" + esc(where) : ""),
      "② <b>무슨 일인지</b>: “넘어졌어요” / “숨이 차요” / “가슴이 아파요” / “어지러워요”",
      s.mobility && s.mobility !== "도움 필요 없음" ? `③ “${esc(s.mobility)}를 쓰고 있어요”` : ""
    ].filter(Boolean).join("<br>");
    $("#sos").hidden = false; vibrate([100, 60, 100]);
    speak("119에 전화하려면 빨간 버튼을 누르세요. 전화가 연결되면, 어디인지와 무슨 일인지 말씀하세요.", { force: true });
    const locEl = $("#sosLoc");
    locEl.textContent = "📍 위치 찾는 중…";
    const r = await requestLocation();
    if (r !== "granted" || !nav.pos) { locEl.textContent = "📍 위치를 몰라요. 주변 건물 이름이나 간판을 말씀하세요."; return; }
    const { lat, lng } = nav.pos;
    let addr = "";
    try {
      const j = await (await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=ko&zoom=18&lat=${lat}&lon=${lng}`)).json();
      const a = j.address || {};
      addr = [a.city || a.county || a.state, a.borough || a.city_district, a.suburb || a.quarter || a.neighbourhood, a.road, a.house_number].filter(Boolean).join(" ");
      if (j.name) addr += ` (${j.name} 근처)`;
    } catch {}
    locEl.innerHTML = `📍 <b>${esc(addr || "주소를 못 찾았어요")}</b><br><small>위도 ${lat.toFixed(5)}, 경도 ${lng.toFixed(5)}${nav.acc ? ` · 오차 약 ${Math.round(nav.acc)}m` : ""}</small>`;
  }
  $("#btn119").onclick = openSOS;
  $("#sosClose").onclick = () => { $("#sos").hidden = true; stopSpeaking(); };
  $("#sosNear").onclick = () => openNear("er");
  $("#call119").onclick = () => { stopSpeaking(); };

  // ───────────────────────── 가까운 병원 · 응급실 ─────────────────────────
  // 1순위: 공공데이터(국립중앙의료원) — 키는 중계 서버(server.py 또는 worker.js)에만 있음
  // 2순위: 키가 없으면 OpenStreetMap(Overpass) 무료 데이터
  const near = { kind: "er", list: [], src: "", loading: false, back: "talk" };
  const API_BASE = (window.HG_CONFIG && window.HG_CONFIG.apiBase || "").replace(/\/$/, "");
  async function fetchPublic(kind, p) {
    const base = API_BASE || (server.data ? "" : null);
    if (base === null) return null;
    try {
      const r = await fetch(`${base ? base + "/" : ""}api/near?type=${kind}&lat=${p.lat}&lng=${p.lng}`);
      if (!r.ok) return null;
      const j = await r.json();
      return Array.isArray(j.items) ? j.items : null;
    } catch { return null; }
  }
  // 무료 대체: OpenStreetMap(Nominatim) 에서 주변 병원 찾기
  async function fetchOSM(kind, p) {
    const span = kind === "er" ? 0.08 : 0.02;           // 응급실 약 8km, 병원 약 2km
    const vb = [p.lng - span, p.lat + span, p.lng + span, p.lat - span].join(",");
    const queries = kind === "er" ? ["hospital"] : ["[amenity=hospital]", "[amenity=clinic]", "[amenity=doctors]"];
    const seen = new Set(), out = [];
    for (const q of queries) {
      const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=kr&accept-language=ko&limit=40&bounded=1&extratags=1&addressdetails=1&viewbox=${vb}&q=${encodeURIComponent(q)}`;
      const r = await fetch(u); if (!r.ok) continue;
      for (const x of await r.json()) {
        const name = x.name; if (!name || seen.has(name)) continue;
        // 응급실 찾기: 요양병원·한의원·치과·의원은 응급실이 없으니 뺌
        if (kind === "er" && (!/병원|의료원|의료센터/.test(name) || /요양|한방|한의|치과|의원$|동물/.test(name))) continue;
        if (/동물/.test(name)) continue;
        seen.add(name);
        const t = x.extratags || {}, a = x.address || {};
        out.push({
          name, lat: +x.lat, lng: +x.lon,
          addr: [a.city || a.county, a.borough || a.city_district, a.road, a.house_number].filter(Boolean).join(" "),
          tel: t.phone || t["contact:phone"] || "",
          kind: kind === "er" ? (t.emergency === "yes" ? "응급실 있음" : "응급실 여부는 전화로 확인") : (t["healthcare:speciality"] || (x.type === "hospital" ? "병원" : "의원"))
        });
      }
    }
    return out;
  }
  async function loadNear() {
    const box = $("#nearList"); if (!box) return;
    near.loading = true; box.innerHTML = `<p class="muted">가까운 ${near.kind === "er" ? "응급실" : "병원"}을 찾는 중…</p>`;
    let p = nav.pos;
    if (!p) { const r = await requestLocation(); p = nav.pos; if (r !== "granted" || !p) { box.innerHTML = `<div class="sign">📍 위치를 알 수 없어요. <button class="btn btn-light" id="nearPerm">위치 켜는 방법 보기</button></div>`; $("#nearPerm").onclick = () => go("perm"); return speak("위치를 알 수 없어요. 위치를 켜 주세요."); } }
    let list = await fetchPublic(near.kind, p), src = "공공데이터 (국립중앙의료원)";
    if (!list) {
      try { list = await fetchOSM(near.kind, p); src = "OpenStreetMap (무료 지도 데이터 · 공공데이터 키를 연결하면 더 정확해요)"; }
      catch { box.innerHTML = `<p class="muted">인터넷 연결을 확인해 주세요.</p>`; return; }
    }
    list.forEach(x => { x.d = distanceM(p, x); });
    list.sort((a, b) => a.d - b.d);
    near.list = list.slice(0, 12); near.src = src; near.loading = false;
    paintNear(p);
  }
  function paintNear(p) {
    const box = $("#nearList"); if (!box) return;
    const L0 = near.list;
    $("#nearSrc").textContent = `자료: ${near.src}`;
    if (!L0.length) { box.innerHTML = `<p class="muted">가까운 곳을 찾지 못했어요.</p>`; return speak("가까운 곳을 찾지 못했어요."); }
    box.innerHTML = "";
    L0.forEach((h, i) => {
      const card = document.createElement("section");
      card.className = "card near-card";
      const tel = (h.erTel || h.tel || "").replace(/[^0-9]/g, "");
      card.innerHTML = `
        <div class="near-head"><span class="near-no">${i + 1}</span>
          <div><p class="near-name">${esc(h.name)}</p>
          <p class="muted">${distText(h.d)} · ${esc(h.kind || "")}${h.open ? ` · 오늘 ${esc(h.open)}~${esc(h.close || "")}` : ""}</p></div></div>
        ${h.beds != null ? `<p class="near-beds ${h.beds > 0 ? "ok" : "no"}">🛏 응급실 빈 침대 ${h.beds > 0 ? h.beds + "개" : "없음"} <small>${esc(h.bedsAt || "")}</small></p>` : ""}
        ${h.addr ? `<p class="muted" style="font-size:17px">${esc(h.addr)}</p>` : ""}
        <div class="row2"></div>`;
      const r2 = card.querySelector(".row2");
      if (tel) { const a = document.createElement("a"); a.className = "btn btn-light"; a.href = "tel:" + tel; a.innerHTML = "📞 전화"; r2.append(a); }
      else r2.append(btn("📞 번호 없음", "btn-light", () => speak("전화번호가 없어요.")));
      r2.append(btn("🧭 길 안내", "btn-primary", () => { state.dest = { name: h.name, lat: h.lat, lng: h.lng }; state.outIdx = 0; save(); go("outdoor"); }));
      box.append(card);
    });
    // 지도
    if (hasLeaflet() && $("#nearMap")) {
      if (maps.near) maps.near.remove();
      const m = maps.near = L.map("nearMap", { attributionControl: true }); tiles(m);
      const pts = [[p.lat, p.lng]];
      L.marker([p.lat, p.lng], { icon: meIcon(), interactive: false }).addTo(m);
      L0.forEach((h, i) => { pts.push([h.lat, h.lng]); L.marker([h.lat, h.lng], { icon: L.divIcon({ className: "num-pin", html: `<span>${i + 1}</span>`, iconSize: [34, 34], iconAnchor: [17, 17] }) }).addTo(m); });
      m.fitBounds(L.latLngBounds(pts.slice(0, 6)).pad(0.15));
    }
    const f = L0[0];
    speak(`가장 가까운 ${near.kind === "er" ? "응급실은" : "병원은"} ${f.name}이에요. 여기서 ${distText(f.d).replace("km", "킬로미터").replace("m", "미터")}예요.${f.beds === 0 ? " 지금 응급실 빈 침대가 없다고 나와요. 전화로 먼저 물어보세요." : ""} 전화 버튼이나 길 안내 버튼을 누르세요.`);
  }
  function renderNear() {
    setStep(near.kind === "er" ? "🚑 가까운 응급실" : "🏥 가까운 병원", "");
    main.innerHTML = `
      <div class="tabs" role="tablist">
        <button role="tab" class="tab ${near.kind === "er" ? "on" : ""}" data-k="er" aria-selected="${near.kind === "er"}">🚑 응급실</button>
        <button role="tab" class="tab ${near.kind === "hosp" ? "on" : ""}" data-k="hosp" aria-selected="${near.kind === "hosp"}">🏥 병원·의원</button>
      </div>
      ${near.kind === "er" ? `<p class="sign" style="font-size:18px">많이 위급하면 기다리지 말고 <b>119</b>에 전화하세요. 119가 알맞은 응급실로 데려다줘요.</p>` : ""}
      <div id="nearMap" class="map mini"></div>
      <div id="nearList" class="near-list"></div>
      <p class="muted" id="nearSrc" style="font-size:15px"></p>`;
    main.querySelectorAll("[data-k]").forEach(b => b.onclick = () => { near.kind = b.dataset.k; renderNear(); });
    dock.replaceChildren(
      ...(near.kind === "er" ? [btn("🚨 119 전화", "btn-xl btn-sos", openSOS)] : []),
      row(btn("🔄 다시 찾기", "btn-light", loadNear), btn("⬅ 돌아가기", "btn-light", () => go(near.back || "talk")))
    );
    loadNear();
  }
  function openNear(kind) {
    if (state.screen !== "near") near.back = state.screen === "doctor" ? "talk" : state.screen;
    near.kind = kind || near.kind; $("#sos").hidden = true; go("near");
  }

  // ───────────────────────── 버스 실시간 도착 (경기도 버스정보) ─────────────────────────
  const bus = { timer: null, said: {}, lastMin: null };
  function busBase() {
    if (API_BASE) return API_BASE + "/";
    return server.bus ? "" : null;
  }
  function stopBus() { clearInterval(bus.timer); bus.timer = null; }
  async function startBus(step) {
    stopBus(); bus.said = {};
    if (!step.bus) return;
    await healthDone;                       // 서버에 버스 정보가 있는지 먼저 확인
    if (busBase() === null || !$("#busCard")) return;
    const tick = () => loadBus(step);
    tick(); bus.timer = setInterval(tick, 30000);
  }
  async function loadBus(step) {
    const card = $("#busCard"); if (!card) return stopBus();
    // 버스에 탄 뒤(타는 곳에서 150m 넘게 멀어지면)에는 도착 정보 대신 내릴 곳 안내만
    const board = RT().outdoor.find(s => s.bus && s.type === "walk") || step;
    if (step.type === "bus" && nav.pos && distanceM(nav.pos, board) > 150) { card.hidden = true; return; }
    let items;
    try {
      const r = await fetch(`${busBase()}api/bus?stationId=${step.bus.stationId}`);
      if (!r.ok) throw 0;
      items = (await r.json()).items || [];
    } catch { card.hidden = true; return; }
    const mine = items.find(x => String(x.routeId) === String(step.bus.routeId));
    const alts = items.filter(x => x !== mine && /서울대병원|서울대학교병원/.test(x.dest) && x.buses.length);
    const name = step.bus.routeName;
    const line = (b) => `<b>${b.min <= 1 ? "곧 도착" : `약 ${b.min}분 뒤`}</b>${b.stops ? ` · ${b.stops}정거장 전` : ""}${b.low ? ' · <span class="low">♿ 저상버스</span>' : ""}`;
    let html = `<p class="bus-title">🚌 ${esc(name)}번 버스</p>`;
    if (mine && mine.buses.length) html += mine.buses.map((b, i) => `<p class="bus-row">${i === 0 ? "이번" : "다음"} 버스: ${line(b)}</p>`).join("");
    else html += `<p class="bus-row">지금 오는 버스가 없어요.<br><small>이 정류장이 ${esc(name)}번 출발점이라, 버스가 정류장에 서서 기다렸다가 출발해요.</small></p>`;
    if (alts.length) html += `<p class="bus-alt">같은 곳(서울대병원)에 가는 다른 버스: ${alts.slice(0, 2).map(a => `<b>${esc(a.routeName)}번</b> ${a.buses[0].min}분 뒤`).join(", ")}</p>`;
    html += `<p class="muted" style="font-size:14px;margin:6px 0 0">경기도 버스정보 · 30초마다 새로고침</p>`;
    card.innerHTML = html; card.hidden = false;

    // 음성: 처음 한 번, 그리고 곧 도착할 때 한 번
    const first = mine && mine.buses[0];
    if (!bus.said.first) {
      bus.said.first = true;
      setTimeout(() => {
        if (first) speak(`${name}번 버스는 약 ${first.min}분 뒤에 와요.${first.low ? " 저상버스라 보행기로 타기 편해요." : ""}`);
        else speak(`${name}번은 이 정류장에서 출발하는 버스예요. 정류장에서 기다리시면 돼요.${alts.length ? ` ${alts[0].routeName}번 버스도 서울대병원에 가요.` : ""}`);
      }, 6000);
    }
    if (first && first.min <= 2 && !bus.said.soon) {
      bus.said.soon = true; vibrate([200, 100, 200]);
      speak(`${name}번 버스가 곧 들어와요. 앞문 쪽에서 버스가 완전히 멈출 때까지 기다리세요.`);
    }
  }

  // ───────────────────────── 렌더 ─────────────────────────
  function render() {
    document.body.classList.toggle("reduce", state.reduce);
    if (maps.pick) { maps.pick.remove(); maps.pick = null; }
    if (maps.mini) { maps.mini.remove(); maps.mini = null; }
    if (maps.near) { maps.near.remove(); maps.near = null; }
    ({ near: renderNear, doctor: renderDoctor, perm: renderPerm, pick: renderPick, talk: renderTalk, confirm: renderConfirm, apply: renderApply, outdoor: renderOutdoor, indoor: renderIndoor, done: renderDone }[state.screen] || renderTalk)();
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function resetAll() {
    stopSpeaking(); stopNav(); store.clear();
    Object.assign(state, { screen: "talk", slots: { hospital: null, firstVisit: null, mobility: null, reception: null }, heard: "", outIdx: 0, inIdx: 0, dest: null });
    nav.pos = null; nav.heading = null; save(); render();
  }

  // ───────────────────────── 상단 버튼 / 설정 ─────────────────────────
  const soundBtn = $("#btnSound");
  function paintSound() { soundBtn.textContent = state.sound ? "🔊" : "🔇"; soundBtn.setAttribute("aria-label", state.sound ? "소리 켜짐 (누르면 끔)" : "소리 꺼짐 (누르면 켬)"); soundBtn.setAttribute("aria-pressed", state.sound); }
  soundBtn.onclick = () => { state.sound = !state.sound; if (!state.sound) stopSpeaking(); save(); paintSound(); };
  paintSound();

  function updateEngineInfo() {
    loadVoices();
    $("#engineInfo").textContent =
      `말 알아듣기: ${server.ai ? "AI(GPT) 해석" : "기기 안 규칙 해석"} · 목소리: ${server.tts ? "AI 자연 음성 사용 가능" : "기기 내장 한국어 음성"} · 음성 인식: ${SR ? "사용 가능" : "지원 안 됨"}`;
  }
  $("#btnDoctor").onclick = openDoctor;
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
  $("#permAgain").onclick = () => { $("#settings").hidden = true; perm.loc = perm.mic = perm.compass = "unknown"; go("perm"); };
  $("#resetAll").onclick = () => { $("#settings").hidden = true; resetAll(); };

  // 브라우저 자동재생 정책: 첫 터치 후에야 소리가 나므로, 첫 터치 때 현재 안내를 다시 읽음
  let unlocked = false;
  document.addEventListener("pointerdown", (e) => {
    if (unlocked) return; unlocked = true;
    if (e.target.closest("button, select, input")) return;
    if (synth && !synth.speaking && state.lastSaid && state.sound) setTimeout(() => { if (!synth.speaking) speak(state.lastSaid); }, 50);
  }, { once: false, capture: true });

  const iosNeedsCompassTap = typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function";
  if (!iosNeedsCompassTap) startCompass();
  else {
    const askOnTap = () => {
      if (nav.orientHandler || nav.sensorAsked) return;
      nav.sensorAsked = true;
      DeviceOrientationEvent.requestPermission().then(r => {
        perm.compass = r === "granted" ? "granted" : "denied";
        if (r === "granted") { startCompass(); const sb = $("#sensorBtn"); if (sb) sb.hidden = true; }
        paintArrow();
      }).catch(() => { nav.sensorAsked = false; });
    };
    document.addEventListener("click", askOnTap, true);
    document.addEventListener("touchend", askOnTap, true);
  }

  render();
})();
