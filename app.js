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
  function go(screen) { state.screen = screen; save(); stopNav(); render(); window.scrollTo(0, 0); }
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
      </section>`;
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
    stopCompass();
  }
  function setGpsStatus(t, bad) { const el = $("#gpsStatus"); if (el) { el.textContent = t; el.classList.toggle("bad", !!bad); } }

  function renderOutdoor() {
    const i = state.outIdx, step = RT().outdoor[i];
    if (!step) return go(RT().indoor.length ? "indoor" : "done");
    nav.arrived = false; nav.nearSaid = false; nav.lastDirWord = ""; nav.lastDirSpokeAt = 0;
    setStep(`2. 가는 길 ${i + 1}/${RT().outdoor.length}`, step.type === "bus" ? "버스 타기" : "걷기");
    main.innerHTML = `
      <div class="progress">${RT().outdoor.map((_, k) => `<i class="${k <= i ? "on" : ""}"></i>`).join("")}</div>
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
      <section class="sign" id="signBox">🪧 ${step.sign}</section>
      <div id="miniMap" class="map mini" aria-label="내 위치와 목적지 지도"></div>`;
    makeMiniMap(step);
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
      sb.onclick = async () => { nav.sensorAsked = true; sb.hidden = true; if (await askSensorPermission()) startCompass(); };
    } else startCompass();
    startGPS();
    speak(step.voice);
    // 3초 뒤에도 나침반 값이 없으면 지도 기준(북쪽=위) 화살표로 안내
    setTimeout(() => { if (state.screen === "outdoor") updateNavUI(); }, 3000);
  }

  function updateNavUI() {
    if (state.screen !== "outdoor") return;
    const step = RT().outdoor[state.outIdx]; if (!step) return;
    const arrow = $("#arrow"); if (!arrow) return;
    if (!nav.pos) { $("#dirWord").textContent = "위치를 찾는 중…"; return; }
    updateMiniMap(step);
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
    dock.replaceChildren(btn("🏠 처음 화면으로", "btn-xl btn-light", () => resetAll()), row(replayBtn(), helpBtn()));
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
      perm.loc = await requestLocation();
      perm.mic = await requestMic();
      if (needCompass) { perm.compass = await requestCompass(); if (perm.compass === "granted") startCompass(); }
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
      <button class="btn btn-light" id="presetBtn">🏥 분당서울대병원 (미금역에서 출발 · 확인된 경로)</button>`;

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

  // ───────────────────────── 렌더 ─────────────────────────
  function render() {
    document.body.classList.toggle("reduce", state.reduce);
    if (maps.pick) { maps.pick.remove(); maps.pick = null; }
    if (maps.mini) { maps.mini.remove(); maps.mini = null; }
    ({ perm: renderPerm, pick: renderPick, talk: renderTalk, confirm: renderConfirm, apply: renderApply, outdoor: renderOutdoor, indoor: renderIndoor, done: renderDone }[state.screen] || renderTalk)();
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function resetAll() {
    stopSpeaking(); stopNav(); store.clear();
    Object.assign(state, { screen: "talk", slots: { hospital: null, firstVisit: null, mobility: null, reception: null }, heard: "", outIdx: 0, inIdx: 0, dest: null });
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
  $("#permAgain").onclick = () => { $("#settings").hidden = true; perm.loc = perm.mic = perm.compass = "unknown"; go("perm"); };
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
