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
    clear() { try { Object.keys(localStorage).filter(k => k.startsWith("hg:") && !["hg:permDone", "hg:guardians", "hg:gopts"].includes(k)).forEach(k => localStorage.removeItem(k)); } catch {} }
  };

  const state = {
    screen: store.get("screen", store.get("permDone", false) ? "home" : "perm"),   // talk | confirm | apply | outdoor | indoor | done
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
  const spokeDone = () => window.dispatchEvent(new Event("hg:spoken"));
  async function speak(text, { force = false, lang = "ko-KR" } = {}) {
    if (lang === "ko-KR") state.lastSaid = text;
    if (!state.sound && !force) { spokeDone(); return; }
    stopSpeaking();
    window.dispatchEvent(new Event("hg:speaking"));
    const token = speakToken;
    const useServer = lang === "ko-KR" && server.tts && ($("#voiceSelect").value === "server");
    if (useServer) {
      try {
        const r = await fetch("api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, speed: state.rate }) });
        if (!r.ok) throw new Error("tts");
        const blob = await r.blob();
        if (token !== speakToken) return;
        audioEl = new Audio(URL.createObjectURL(blob));
        audioEl.onended = () => { if (token === speakToken) spokeDone(); };
        await audioEl.play();
        return;
      } catch { /* 기기 목소리로 넘어감 */ }
    }
    if (!synth) return spokeDone();
    const v = lang === "ko-KR"
      ? (voices.find(x => x.voiceURI === $("#voiceSelect").value) || voices[0])
      : synth.getVoices().filter(x => x.lang.replace("_", "-").toLowerCase().startsWith(lang.slice(0, 2).toLowerCase())).sort((x, y) => scoreAny(y) - scoreAny(x))[0];
    const parts = splitSentences(text);
    parts.forEach((s, i) => {
      const u = new SpeechSynthesisUtterance(s);
      u.lang = lang; if (v) u.voice = v;
      u.rate = state.rate; u.pitch = 1.0; u.volume = 1;
      if (i === parts.length - 1) u.onend = () => { if (token === speakToken) spokeDone(); };
      synth.speak(u);
    });
  }
  function scoreAny(v) { let s = 0; NATURAL_HINTS.forEach((re, i) => { if (re.test(v.name)) s += 20 - i; }); return s; }
  function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch {} }

  // ───────────────────────── 음성 인식 ─────────────────────────
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  // 말하기: 브라우저 음성 인식 → 안 되면 휴대폰 키보드의 🎤(받아쓰기)로 대신 입력
  let activeRec = null;
  // 말하기 시작 알림음 ("띵") — 언제 말하면 되는지 소리로 알려 줌
  let beepCtx = null;
  function beep(freq = 880, ms = 140) {
    try {
      beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = beepCtx.createOscillator(), g = beepCtx.createGain();
      o.frequency.value = freq; o.connect(g); g.connect(beepCtx.destination);
      const t = beepCtx.currentTime; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      o.start(t); o.stop(t + ms / 1000 + 0.02);
    } catch {}
  }
  // 큰 "말씀하세요" 화면
  function listenSheet(prompt) {
    let el = $("#listenSheet");
    if (!el) {
      el = document.createElement("div"); el.id = "listenSheet"; el.className = "overlay listen-sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-live", "polite");
      el.innerHTML = `<div class="ls-inner">
        <p class="ls-prompt" id="lsPrompt"></p>
        <div class="ls-mic" id="lsMic" aria-hidden="true">🎙</div>
        <p class="ls-state" id="lsState">말씀하세요</p>
        <p class="ls-text" id="lsText"></p>
        <div class="ls-btns" id="lsBtns"></div>
      </div>`;
      document.body.append(el);
    }
    el.hidden = false;
    $("#lsPrompt").textContent = prompt || "";
    return el;
  }
  function closeListenSheet() { const el = $("#listenSheet"); if (el) el.hidden = true; }

  // 말 듣기
  //  · 누르면 바로 큰 화면 + 띵 소리 → 말하면 글자가 바로 보임
  //  · 말하다가 잠깐 쉬어도(약 3초까지) 끊지 않고 이어서 들음
  //  · 다 말하면 "다 말했어요", 아무 말도 없으면 "다시 말하기" 버튼
  function listen(onText, trigger, opts = {}) {
    if (activeRec) { activeRec.finish(); return; }          // 듣는 중에 한 번 더 누르면 끝
    if (!SR || !isSecureContext || inApp) {
      const adv = browserAdvice();
      return typeFallback(onText, adv ? adv.msg : "이 브라우저는 바로 듣기를 지원하지 않아요.", { openBrowser: !!(adv && adv.btn), openLabel: adv && adv.btn });
    }
    stopSpeaking();
    const big = !opts.quiet;                                   // 자동 듣기·마이크 시험은 큰 화면 없이
    const label = trigger ? (trigger.dataset.label || (trigger.dataset.label = trigger.innerHTML)) : "";
    const PAUSE_OK = 3200, FIRST_WAIT = 10000, MAX = 30000;   // 어르신 말 속도에 맞춘 넉넉한 시간
    const S = { parts: [], cur: "", startedAt: Date.now(), lastSpeech: 0, done: false, cancelled: false, errored: "", rec: null, restarts: 0, timer: null };
    const fullText = () => (S.parts.join(" ") + " " + S.cur).replace(/\s+/g, " ").trim();
    const paint = () => {
      const t = fullText();
      const q = $("#heardLive"); if (q && t) { q.hidden = false; q.textContent = "“" + t + "”"; }
      if (big) { $("#lsText").textContent = t ? "“" + t + "”" : ""; $("#lsState").textContent = t ? "듣고 있어요… 다 말하면 기다리세요" : "말씀하세요"; }
    };
    const setBtns = (mode) => {
      if (!big) return;
      const b = $("#lsBtns"); b.innerHTML = "";
      if (mode === "listening") {
        b.append(btn("✅ 다 말했어요", "btn-xl btn-primary", () => api.finish()), btn("✖ 그만", "btn-light", () => api.cancel()));
      } else if (mode === "nothing") {
        b.append(btn("🎙 다시 말하기", "btn-xl btn-talk", () => { closeListenSheet(); listen(onText, btn_, opts); }),
          btn("⌨️ 글자로 쓰기", "btn-light", () => { closeListenSheet(); typeFallback(onText); }), btn("✖ 닫기", "btn-light", () => closeListenSheet()));
      }
    };
    const btn_ = trigger;
    const uiOn = () => {
      if (trigger) { trigger.classList.add("listening"); trigger.innerHTML = "🎙 듣고 있어요…"; }
      if (big) { listenSheet(opts.prompt); $("#lsMic").classList.add("on"); paint(); setBtns("listening"); }
    };
    const uiOff = () => {
      if (trigger) { trigger.classList.remove("listening"); trigger.innerHTML = label; }
      if (big) $("#lsMic").classList.remove("on");
    };
    const end = () => {
      clearInterval(S.timer); activeRec = null; uiOff();
      const t = fullText();
      if (S.cancelled) { closeListenSheet(); return; }
      if (t) {
        listen.miss = 0;
        if (big) { $("#lsState").textContent = "✅ 이렇게 들었어요"; $("#lsBtns").innerHTML = ""; beep(660, 120); setTimeout(closeListenSheet, 900); }
        return onText(t);
      }
      const er = S.errored;
      if (er === "not-allowed" || er === "service-not-allowed") {
        closeListenSheet();
        if (opts.quiet) {
          if (opts.onDenied) return opts.onDenied(er);
          if (typeof setHandsfree === "function" && HF.on) { HF.on = false; store.set("handsfree", false); fab.classList.remove("hf"); }
          return speak(isIOS ? "아이폰에서는 말할 때마다 오른쪽 아래 마이크 버튼을 눌러 주세요." : "마이크가 막혀 있어요. 메뉴의 마이크 시험에서 고칠 수 있어요.");
        }
        perm.mic = "denied";
        const why = isIOS ? "마이크나 받아쓰기가 꺼져 있어요." : "마이크가 막혀 있어요.";
        speak(why + " 마이크 고치는 방법을 볼 수 있어요.");
        return typeFallback(onText, why, { fixMic: true });
      }
      if (er === "audio-capture") { closeListenSheet(); speak("다른 앱이 마이크를 쓰고 있어요."); return typeFallback(onText, "다른 앱이 마이크를 쓰고 있어요. 통화나 녹음을 끄고 다시 해 보세요."); }
      if (er === "network" || er === "language-not-supported") { closeListenSheet(); return typeFallback(onText, "인터넷이 약해서 바로 듣기가 안 돼요."); }
      if (opts.quiet) { if (opts.onIdle) opts.onIdle(); return; }
      // 아무 말도 못 들음 → 큰 화면에서 바로 다시
      listen.miss = (listen.miss || 0) + 1;
      $("#lsState").textContent = "잘 안 들렸어요";
      $("#lsText").textContent = listen.miss >= 2 ? "휴대폰을 입 가까이 대고, 조금 크게 말씀해 보세요. 글자로 써도 돼요." : "‘다시 말하기’를 누르고 말씀해 주세요.";
      setBtns("nothing");
      speak("잘 안 들렸어요. 다시 말하기를 누르고, 휴대폰에 입을 가까이 대고 말씀해 주세요.", { force: true });
    };
    const startOne = () => {
      let rec;
      try { rec = new SR(); } catch { S.errored = "error"; return end(); }
      rec.lang = "ko-KR"; rec.interimResults = true; rec.maxAlternatives = 1; rec.continuous = false;
      rec.onresult = (e) => {
        let t = ""; for (const r of e.results) t += r[0].transcript;
        S.cur = t; S.lastSpeech = Date.now(); paint();
      };
      rec.onerror = (e) => { if (e.error !== "no-speech" && e.error !== "aborted") S.errored = e.error || "error"; };
      rec.onend = () => {
        if (S.cur.trim()) S.parts.push(S.cur.trim()); S.cur = "";
        if (S.done || S.cancelled || S.errored) return end();
        const now = Date.now(), heard = S.parts.length > 0;
        // 말하다 잠깐 쉰 거면, 혹은 아직 첫 말을 기다리는 중이면 이어서 듣기
        const keep = heard ? now - S.lastSpeech < PAUSE_OK : now - S.startedAt < FIRST_WAIT;
        if (keep && now - S.startedAt < MAX && S.restarts < 12) {
          S.restarts++;
          try { startOne(); return; } catch { /* 다시 켜기가 막힌 휴대폰은 여기서 끝 */ }
        }
        end();
      };
      S.rec = rec;
      rec.start();
    };
    const api = {
      finish() { S.done = true; try { S.rec && S.rec.stop(); } catch { end(); } },
      cancel() { S.cancelled = true; try { S.rec && S.rec.abort(); } catch { end(); } },
      stop() { api.finish(); }, abort() { api.cancel(); }
    };
    activeRec = api;
    uiOn();
    try { startOne(); } catch { activeRec = null; uiOff(); closeListenSheet(); return typeFallback(onText); }
    beep(); vibrate(40);
    // 지켜보기: 말이 끝나고 조용하면 마무리, 너무 오래 아무 말 없으면 마무리
    S.timer = setInterval(() => {
      const now = Date.now(), heard = S.parts.length > 0 || S.cur.trim();
      if ((heard && S.lastSpeech && now - S.lastSpeech > PAUSE_OK) || (!heard && now - S.startedAt > FIRST_WAIT) || now - S.startedAt > MAX) {
        clearInterval(S.timer); S.done = true; try { S.rec && S.rec.stop(); } catch { end(); }
      }
    }, 300);
  }

  // 대체 입력: 휴대폰 키보드의 🎤 버튼(받아쓰기)은 거의 모든 휴대폰에서 됩니다
  function typeFallback(onText, reason = "", fx = {}) {
    const old = $("#typeSheet"); if (old) old.remove();
    const wrap = document.createElement("div");
    wrap.id = "typeSheet"; wrap.className = "overlay sheet"; wrap.setAttribute("role", "dialog");
    wrap.innerHTML = `<div class="sheet-inner">
        ${reason ? `<p class="muted">${esc(reason)}</p>` : ""}
        <p class="big" style="font-size:26px">아래 칸을 누르고,<br>키보드의 <span class="kbd">🎤</span> 버튼을 눌러 말씀하세요.</p>
        <p class="muted">${isIOS ? "키보드 오른쪽 아래(또는 스페이스 옆)에 있는 마이크 모양이에요." : "키보드 위쪽 줄이나 오른쪽 위에 있는 마이크 모양이에요."} 글자로 써도 돼요.</p>
        <textarea id="typeBox" rows="3" placeholder="예) 분당서울대병원 처음 가요"></textarea>
        <button class="btn btn-xl btn-primary" id="typeOk">✅ 다 말했어요</button>
        ${fx.fixMic ? '<button class="btn btn-light" id="typeFix">🎙 마이크 고치기 (시험해 보기)</button>' : ""}
        ${fx.openBrowser ? `<button class="btn btn-light" id="typeOpen">${esc(fx.openLabel || "🌐 다른 브라우저로 열기")}</button>` : ""}
        <button class="btn btn-light" id="typeCancel">닫기</button>
      </div>`;
    document.body.append(wrap);
    const box = wrap.querySelector("#typeBox");
    setTimeout(() => box.focus(), 50);
    wrap.querySelector("#typeOk").onclick = () => { const t = box.value.trim(); wrap.remove(); if (t) onText(t); };
    wrap.querySelector("#typeCancel").onclick = () => wrap.remove();
    const tf = wrap.querySelector("#typeFix"); if (tf) tf.onclick = () => { wrap.remove(); openScreen("mictest"); };
    const to = wrap.querySelector("#typeOpen"); if (to) to.onclick = () => openInGoodBrowser();
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
  function go(screen) { if (typeof micTestStop === "function") micTestStop(); if (screen !== "doctor" && typeof docStopRec === "function") docStopRec(); state.screen = screen; save(); stopNav(); render(); window.scrollTo(0, 0); }
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
    const hg = $("#helpGuardian"); if (hg) hg.hidden = !G.list().length;
    vibrate(80);
    speak("직원분께 이 화면을 보여 주세요.");
  }
  $("#helpClose").onclick = () => { $("#helpCard").hidden = true; };

  // ───────────────────────── 화면 1: 말하기 ─────────────────────────
  // "병원 가는 길 시작": 화면을 열면서 바로 듣기 (한 번만 누르면 됨)
  const TALK_PROMPT = "어느 병원에 가세요?\n예) “분당서울대병원 처음 가요. 보행기 써요”";
  function startTalk() {
    go("talk");
    const tb = dock.querySelector(".btn-talk");
    listen(handleUtterance, tb, { prompt: TALK_PROMPT });
  }
  // 처음 화면에서 아무 말이나: 명령 → 병원 가기 → 병원 찾기 순서로 알아듣기
  function homeVoice(t) {
    const tt = t.replace(/\s+/g, " ");
    if (CMD.find(([re]) => re.test(tt)) && !/가요|갈래|가야|가려/.test(tt)) return runCommand(t);
    if (/분당\s*서울대|서울대|보행기|휠체어|처음\s*가|접수|동행|병원\s*(가|에\s*가)/.test(tt)) { go("talk"); return handleUtterance(t); }
    const d = deptQuery(t);
    if (d) return openNear("hosp", d);
    if (/병원|의원|약국|치과|한의원|보건소/.test(tt)) return openNear("hosp", tt.replace(/(에\s*)?(가고\s*싶어요?|가요|갈래요?|찾아\s*줘|찾아\s*주세요|어디\s*있어요?|어디예요)\s*$/, "").trim());
    return runCommand(t);
  }
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
    main.append(btn("⬅ 처음 화면", "btn-light", () => go("home")));
    main.querySelectorAll("[data-q]").forEach(b => b.onclick = () => handleUtterance(b.dataset.q));
    const talk = btn("🎙 누르고 말하기", "btn-xl btn-talk", () => listen(handleUtterance, talk, { prompt: TALK_PROMPT }));
    dock.replaceChildren(talk, row(btn("⌨️ 키보드로 말하기", "btn-light", () => typeFallback(handleUtterance)), btn("✋ 직접 고르기", "btn-light", () => { go("confirm"); })));
    speak("노란 버튼을 누르고, 어느 병원에 가시는지 편하게 말씀해 주세요.");
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
    ), btn("☰ 택시 · 여기가 어디 · 다른 도움", "btn-light more-btn", openMenu));

    // 센서 권한: iOS 는 버튼 눌러야 함
    const needsTap = typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function";
    if (needsTap && !nav.sensorAsked) {
      const sb = $("#sensorBtn"); sb.hidden = false;
      sb.onclick = async () => { sb.hidden = true; if (nav.orientHandler || nav.sensorAsked) return; nav.sensorAsked = true; const ok = await askSensorPermission(); nav.sensorAsked = true; perm.compass = ok ? "granted" : "denied"; if (ok) startCompass(); paintArrow(); };
    } else startCompass();
    startGPS();
    speak(step.voice);
    if (i === 0) setTimeout(() => notifyGuardians("start", `병원 가는 길 안내를 시작했어요. 가는 곳: ${isPreset() ? "분당서울대병원 (미금역 → 7-1번 버스)" : state.dest.name}`), 4500);
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
    const was = RT().outdoor[state.outIdx];
    if (was && was.type === "bus") setTimeout(() => notifyGuardians("bus", "7-1번 버스에서 서울대병원 정류장에 잘 내렸어요."), 4000);
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
    main.append(btn("📷 표지판 찍어서 물어보기", "btn-light", () => openScreen("where")));
    dock.replaceChildren(
      btn(i === RT().indoor.length - 1 ? "✅ 창구에 도착했어요" : "👍 했어요 · 다음", "btn-xl btn-primary", () => { state.inIdx++; save(); vibrate(60); renderIndoor(); }),
      row(replayBtn(), btn("⬅ 이전 단계", "btn-light", () => { if (state.inIdx > 0) { state.inIdx--; save(); renderIndoor(); } else { state.outIdx = RT().outdoor.length - 1; go("outdoor"); } })),
      btn("🙋 직원에게 보여줄 도움 문장 크게 켜기", "btn-xl btn-help", openHelp)
    );
    speak(step.voice);
    if (i === 0) setTimeout(() => notifyGuardians("arrive", "분당서울대병원 1동에 잘 도착했어요. 이제 처음오신 창구로 가요."), 4500);
  }

  function renderDone() {
    setStep("도착!", "수고하셨어요");
    if (!isPreset()) {
      main.innerHTML = `<section class="card"><p class="big">${esc(state.dest.name)}에<br>잘 도착하셨어요. 👏</p><p style="margin-top:12px">건물 간판의 이름이 맞는지 한 번 더 확인하세요.</p></section>`;
      dock.replaceChildren(btn("🗺 다른 곳 고르기", "btn-xl btn-light", () => go("pick")), row(replayBtn(), helpBtn()));
      setTimeout(() => notifyGuardians("arrive", `${state.dest.name}에 잘 도착했어요.`), 4000);
      return speak(`${state.dest.name}에 잘 도착하셨어요. 수고 많으셨어요.`);
    }
    main.innerHTML = `<section class="card"><p class="big">처음오신 창구에<br>잘 도착하셨어요. 👏</p>
      <p style="margin-top:12px">번호가 불리면 창구에서 <b>“오늘 예약하고 처음 왔어요”</b> 라고 말씀하세요.</p></section>`;
    dock.replaceChildren(btn("🩺 진료 받을 때 말씀 받아 적기", "btn-xl btn-talk", openDoctor), row(btn("🏠 처음 화면으로", "btn-light", () => { store.set("trip", null); go("home"); }), helpBtn()));
    speak("처음오신 창구에 잘 도착하셨어요. 정말 수고 많으셨어요. 번호가 불리면 창구에서, 오늘 예약하고 처음 왔다고 말씀하세요.");
    setTimeout(() => notifyGuardians("counter", "분당서울대병원 1동 1층 처음오신 창구에 잘 도착했어요. 이제 접수해요."), 7000);
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
      ${perm[k] === "denied" || perm[k] === "error" || perm[k] === "insecure" ? `<div class="sign" style="font-size:18px">${perm[k] === "insecure" ? "https 주소로 열어야 해요." : k === "mic" && !inApp ? micDeniedGuide() : fixGuide(k)}</div>` : ""}`;
    main.innerHTML = `
      <section class="card"><p class="big">길 안내를 하려면<br>두 가지를 켜 주세요.</p>
        <p class="muted" style="margin-top:8px">버튼을 누르면 휴대폰이 물어봐요. <b>‘허용’</b>을 눌러 주세요.</p></section>
      ${inApp ? `<div class="sign" style="font-size:18px">⚠️ ${fixGuide("loc")}</div>` : ""}
      <section class="slots">
        ${item("loc", "📍", "위치(GPS)", "어디로 걸어가야 할지 알려 드려요")}
        ${item("mic", "🎙", "마이크", "말로 병원 이름을 알려 주실 수 있어요")}
        ${item("compass", "🧭", "방향 센서", "휴대폰이 향한 쪽으로 화살표를 돌려요", needCompass)}
      </section>
      ${browserAdvice() ? `<section class="card warn-card"><p style="margin:0;font-size:19px">⚠️ ${esc(browserAdvice().msg)}</p>${browserAdvice().btn ? `<button class="btn btn-primary" id="permOpen" style="margin-top:10px;width:100%">${browserAdvice().btn}</button>` : ""}</section>` : ""}
      <button class="btn btn-light" id="permMicTest" style="width:100%">🎙 마이크가 잘 되는지 시험해 보기</button>
      <p class="muted">이름·음성 녹음은 저장하지 않아요. 위치는 길 안내에만 쓰고 어디에도 보내지 않아요.</p>`;
    const po = $("#permOpen"); if (po) po.onclick = openInGoodBrowser;
    $("#permMicTest").onclick = () => openScreen("mictest");
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
    const next = btn(allOn ? "다음 ▶" : "나중에 할게요 ▶", allOn ? "btn-xl btn-primary" : "btn-light", () => { store.set("permDone", true); go("home"); });
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
    const backBtn = btn("⬅ 돌아가기", "btn-light", () => { docStopRec(); go(doc.back || "home"); });

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
      if (G.list().length) {
        const short = `[진료 메모] ${s.oneLine}` + ["caution", "medicine", "nextVisit"].filter(k => s[k] && s[k].length).map(k => `\n- ${s[k].slice(0, 2).join("\n- ")}`).join("");
        return notifyGuardians("doctor", short, { force: true, urgent: true });
      }
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
    const sg = $("#sosGuardian"); if (sg) { sg.hidden = !G.list().length; }
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
  // ── 병원 검색: 이름 · 진료과 · 약국 ──
  const DEPTS = ["내과", "정형외과", "안과", "이비인후과", "치과", "피부과", "한의원", "가정의학과", "재활의학과", "신경과", "비뇨의학과", "산부인과", "소아청소년과", "약국"];
  const HEALTH_RE = /병원|의원|의료원|의료센터|보건소|클리닉|치과|한의원|약국|내과|외과|안과|이비인후과|피부과|산부인과|비뇨|소아|정신|재활|가정의학|신경|요양/;
  function deptOf(q) {
    const t = q.replace(/\s/g, "");
    if (/약국|약방/.test(t)) return "약국";
    if (/소아과|어린이/.test(t)) return "소아청소년과";
    if (/비뇨/.test(t)) return "비뇨의학과";
    if (/한방|한의/.test(t)) return "한의원";
    if (/귀|코|목/.test(t) && /아프|아파|이비|막혀|가려/.test(t)) return "이비인후과";
    if (/눈/.test(t) && /아프|아파|침침|안보|안 보/.test(t)) return "안과";
    if (/이빨|이가|잇몸|틀니/.test(t)) return "치과";
    if (/무릎|허리|관절|어깨|뼈/.test(t)) return "정형외과";
    return DEPTS.find(d => t.includes(d)) || null;
  }
  // "안과", "근처 안과", "무릎이 아파요" → 진료과 검색 / "김안과", "두리이비인후과" → 이름 검색
  function deptQuery(q) {
    const d = deptOf(q); if (!d) return null;
    const rest = q.replace(/\s/g, "").replace(/근처|가까운|주변|찾아줘|찾아주세요|어디|있어|있나요|예요|에요|가고싶어|좀/g, "")
      .replace(d, "").replace(/소아과|비뇨기과|한방|약방|의원$|병원$/, "");
    const symptom = /아프|아파|침침|안보|막혀|가려/.test(q);
    return symptom || rest.length === 0 ? d : null;
  }
  async function nominatim(q, p, span, bounded) {
    const vb = [p.lng - span, p.lat + span, p.lng + span, p.lat - span].join(",");
    const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=kr&accept-language=ko&limit=40&extratags=1&addressdetails=1&viewbox=${vb}${bounded ? "&bounded=1" : ""}&q=${encodeURIComponent(q)}`;
    const r = await fetch(u); if (!r.ok) throw new Error("search");
    return r.json();
  }
  // 두 번째 지도 검색(Photon): 이름 검색에 강하고, 한쪽이 막혀도 다른 쪽으로 찾음
  async function photon(q, p) {
    const u = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=${p.lat}&lon=${p.lng}&limit=15`;
    const r = await fetch(u); if (!r.ok) throw new Error("photon");
    const j = await r.json();
    return (j.features || []).filter(f => (f.properties.countrycode || "KR") === "KR").map(f => {
      const pr = f.properties, [lng, lat] = f.geometry.coordinates;
      return { _type: pr.osm_value, name: pr.name, lat, lng,
        addr: [pr.city || pr.county, pr.district, pr.street, pr.housenumber].filter(Boolean).join(" "),
        tel: "", kind: pr.osm_value === "pharmacy" ? "약국" : pr.osm_value === "dentist" ? "치과" : pr.osm_value === "hospital" ? "병원" : "의원", hours: "" };
    });
  }
  function osmToItem(x) {
    const t = x.extratags || {}, a = x.address || {};
    return { name: x.name || x.display_name.split(",")[0], lat: +x.lat, lng: +x.lon,
      addr: [a.city || a.county, a.borough || a.city_district, a.road, a.house_number].filter(Boolean).join(" "),
      tel: t.phone || t["contact:phone"] || "",
      kind: t["healthcare:speciality"] || (x.type === "pharmacy" ? "약국" : x.type === "dentist" ? "치과" : x.type === "hospital" ? "병원" : "의원"),
      open: t.opening_hours ? "" : "", hours: t.opening_hours || "" };
  }
  // 주변 병·의원 목록을 모아 두고(10분), 진료과는 이름·진료과 정보로 걸러 냄
  const SPEC = { "안과": /ophthalm/, "정형외과": /orthop/, "내과": /internal|gastro|cardio|endocrin/, "이비인후과": /otolaryn|ent\b/, "피부과": /dermat/,
    "산부인과": /gyn|obstet/, "소아청소년과": /paediat|pediat/, "비뇨의학과": /urolog/, "신경과": /neurolog/, "재활의학과": /rehab|physical/, "가정의학과": /general|family/, "치과": /dent/, "한의원": /traditional|oriental|korean/ };
  const pool = { key: "", at: 0, items: [] };
  const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));
  async function healthPool(p, span) {
    const key = `${p.lat.toFixed(2)},${p.lng.toFixed(2)},${span}`;
    if (pool.key === key && Date.now() - pool.at < 600000) return pool.items;
    const seen = new Set(), items = [];
    for (const q of ["[amenity=doctors]", "[amenity=clinic]", "[amenity=hospital]", "[amenity=dentist]"]) {
      try {
        for (const x of await nominatim(q, p, span, true)) {
          const it = osmToItem(x); if (!it.name || seen.has(it.name)) continue;
          it.spec = ((x.extratags || {})["healthcare:speciality"] || "") + " " + x.type;
          seen.add(it.name); items.push(it);
        }
      } catch {}
      await sleepMs(1100);   // 무료 지도 서버 예절: 1초에 한 번
    }
    if (items.length) Object.assign(pool, { key, at: Date.now(), items });   // 실패한 결과는 기억하지 않음
    near.poolFail = !items.length;
    return items;
  }
  function matchDept(it, dept) {
    const short = dept === "소아청소년과" ? "소아" : dept === "비뇨의학과" ? "비뇨" : dept === "가정의학과" ? "가정의학" : dept === "재활의학과" ? "재활" : dept;
    if (dept !== "치과" && /치과/.test(it.name)) return false;
    if (dept !== "한의원" && /한의원|한방/.test(it.name)) return false;
    if (it.name.includes(short)) return true;
    const re = SPEC[dept]; return !!(re && re.test(it.spec || ""));
  }
  // ── 이름 검색: 줄임말·띄어쓰기·오타에도 찾기 ──
  const ALIAS = [
    [/^(분당)?서울대(학교)?(병원)?$|^서울대학교분당/, "분당서울대학교병원"],
    [/^(분당)?차(병원)?$|^차의과/, "분당차병원"],
    [/^(분당)?제생(병원)?$/, "분당제생병원"],
    [/^아산(병원)?$|^서울아산/, "서울아산병원"],
    [/^삼성(병원)?$|^삼성서울/, "삼성서울병원"],
    [/^세브란스/, "세브란스병원"],
    [/^(서울)?성모(병원)?$/, "서울성모병원"],
    [/^(분당)?보훈(병원)?$/, "중앙보훈병원"],
    [/^성남(시)?의료원$/, "성남시의료원"],
    [/^(분당)?보건소$|^성남.*보건소/, "분당구보건소"]
  ];
  const normName = (t) => t.toLowerCase().replace(/[\s()·.,\-_/'"‘’“”]/g, "").replace(/대병원$/, "대학교병원");
  const coreName = (t) => normName(t).replace(/(대학교병원|병원|의원|클리닉|센터|의료원)$/, "");
  function bigrams(t) { const a = []; for (let i = 0; i < t.length - 1; i++) a.push(t.slice(i, i + 2)); return a; }
  function dice(a, b) {
    const A = bigrams(a), B = bigrams(b); if (!A.length || !B.length) return 0;
    const rest = [...B]; let hit = 0;
    A.forEach(g => { const i = rest.indexOf(g); if (i >= 0) { hit++; rest.splice(i, 1); } });
    return (2 * hit) / (A.length + B.length);
  }
  // 한글을 자모로 풀기: '채' → ㅊㅐ  (모음 하나 틀린 오타도 비슷하게 봄)
  function jamo(t) {
    let o = "";
    for (const ch of t) {
      const c = ch.charCodeAt(0) - 0xac00;
      if (c < 0 || c > 11171) { o += ch; continue; }
      o += String.fromCharCode(0x1100 + Math.floor(c / 588), 0x1161 + Math.floor((c % 588) / 28)) + (c % 28 ? String.fromCharCode(0x11a7 + (c % 28)) : "");
    }
    return o;
  }
  function nameScore(q, name) {
    const a = coreName(q), b = normName(name), bc = coreName(name);
    if (!a) return 0;
    if (bc === a || b === normName(q)) return 1;
    if (b.includes(a)) return 0.92 - Math.min(0.2, (b.length - a.length) * 0.01);
    if (a.includes(bc) && bc.length >= 2) return 0.8;
    // 오타가 한두 글자면 0.5 이상 (짧은 이름은 자모 비교를 하지 않아 엉뚱한 결과를 막음)
    const j = a.length >= 3 && bc.length >= 2 ? dice(jamo(a), jamo(bc)) * 0.9 : 0;
    return Math.max(dice(a, b), dice(a, bc), j);
  }
  function aliasOf(q) { const n = normName(q); const hit = ALIAS.find(([re]) => re.test(n)); return hit ? hit[1] : null; }
  async function searchByName(q, p) {
    const seen = new Set(), out = [];
    const push = (it, score) => {
      if (!it.name || seen.has(it.name)) return;
      // 띄어쓰기만 다른 같은 병원(300m 안)은 하나만
      if (out.some(o => normName(o.name) === normName(it.name) && distanceM(o, it) < 300)) return;
      seen.add(it.name); it.score = score; out.push(it);
    };
    // 1) 내 주변 병·의원 목록에서 비슷한 이름 (오타·줄임말에 강함)
    const scan = (items) => items.forEach(it => { const sc = nameScore(q, it.name); if (sc >= 0.55) push(it, sc); });
    try { scan(await healthPool(p, 0.03)); } catch {}
    // 2) 지도 검색: 별명 → 원래 말 → '병원' 붙이기 → 띄어쓰기 없애기 (찾으면 멈춤)
    const al = aliasOf(q);
    const spaced = q.replace(/\s/g, "").replace(/(.{2,})(이비인후과|정형외과|재활의학과|가정의학과|소아청소년과|비뇨의학과|산부인과|내과|안과|치과|피부과|한의원|신경과|외과)(의원)?$/, "$1 $2$3");
    const variants = [...new Set([al, q, spaced, /병원|의원|약국|치과|센터|보건소|과$/.test(q) ? null : q + "병원", q.replace(/\s/g, "")].filter(Boolean))];
    const take = (it, type) => {
      if (!it.name) return false;
      const health = HEALTH_RE.test(it.name) || ["hospital", "clinic", "doctors", "dentist", "pharmacy"].includes(type);
      if (!health) return false;
      push(it, Math.max(nameScore(q, it.name), al && normName(it.name) === normName(al) ? 1 : 0, 0.55));
      return true;
    };
    for (const v of variants) {
      let got = 0;
      try { for (const it of await photon(v, p)) if (take(it, it._type)) got++; } catch {}
      if (!got) { try { for (const x of await nominatim(v, p, 0.3, false)) if (take(osmToItem(x), x.type)) got++; } catch {} }
      if (got) break;
      await sleepMs(600);
    }
    // 3) 그래도 없으면 더 넓은 주변(약 8km)에서 비슷한 이름
    if (!out.length) { try { scan(await healthPool(p, 0.08)); } catch {} }
    return out;
  }
  // 글자 치는 동안 주변 목록에서 바로 추천 (인터넷 요청 없음)
  function nameSuggest(q) {
    if (!q || q.length < 2 || !pool.items.length) return [];
    return pool.items.map(it => ({ it, sc: nameScore(q, it.name) })).filter(x => x.sc >= 0.5)
      .sort((a, b) => b.sc - a.sc).slice(0, 5).map(x => x.it);
  }

  async function searchHosp(q, p) {
    const dept = deptQuery(q);
    const seen = new Set(), out = [];
    const add = (arr, filter) => arr.forEach(x => {
      const it = osmToItem(x); if (!it.name || seen.has(it.name)) return;
      if (filter && !filter(it, x)) return;
      seen.add(it.name); out.push(it);
    });
    if (dept === "약국") {
      add(await nominatim("[amenity=pharmacy]", p, 0.02, true));
      if (out.length < 3) add(await nominatim("약국", p, 0.04, true));
    } else if (dept) {
      // 진료과: 주변 병·의원(약 3km)에서 이름·진료과 정보로 찾기 → 적으면 약 8km까지 넓힘
      const pick = (arr) => arr.forEach(it => { if (!seen.has(it.name) && matchDept(it, dept)) { seen.add(it.name); out.push(it); } });
      pick(await healthPool(p, 0.03));
      try { add(await nominatim(dept, p, 0.05, true), (it) => matchDept(it, dept)); } catch {}
      if (out.length < 3) pick(await healthPool(p, 0.08));
      // 주변 목록을 못 받았을 때(지도 서버가 바쁠 때) 두 번째 검색으로
      if (out.length < 3) { try { (await photon(dept, p)).forEach(it => { if (!seen.has(it.name) && matchDept(it, dept) && distanceM(p, it) < 15000) { seen.add(it.name); out.push(it); } }); } catch {} }
    } else {
      return { list: await searchByName(q, p), dept: null, byName: true };
    }
    return { list: out, dept };
  }

  async function loadNear() {
    const box = $("#nearList"); if (!box) return;
    near.loading = true; box.innerHTML = `<p class="muted">가까운 ${near.kind === "er" ? "응급실" : "병원"}을 찾는 중…</p>`;
    let p = nav.pos;
    if (!p) { const r = await requestLocation(); p = nav.pos; if (r !== "granted" || !p) { box.innerHTML = `<div class="sign">📍 위치를 알 수 없어요. <button class="btn btn-light" id="nearPerm">위치 켜는 방법 보기</button></div>`; $("#nearPerm").onclick = () => go("perm"); return speak("위치를 알 수 없어요. 위치를 켜 주세요."); } }
    if (near.query) {
      box.innerHTML = `<p class="muted">‘${esc(near.query)}’ 찾는 중… <small>(처음엔 주변 병원을 모으느라 5초쯤 걸려요)</small></p>`;
      try {
        const { list, dept, byName } = await searchHosp(near.query, p);
        list.forEach(x => { x.d = distanceM(p, x); });
        // 이름 검색은 ‘얼마나 비슷한지’ 먼저, 같으면 가까운 순
        list.sort((a, b) => byName ? (Math.round((b.score || 0) * 10) - Math.round((a.score || 0) * 10)) || a.d - b.d : a.d - b.d);
        near.list = list.slice(0, 15); near.src = `‘${near.query}’${dept && dept !== near.query ? ` (${dept})` : ""} 검색 · OpenStreetMap`; near.loading = false;
        return paintNear(p);
      } catch { box.innerHTML = `<p class="muted">인터넷 연결을 확인해 주세요.</p>`; return; }
    }
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
    if (!L0.length) {
      const busy = near.poolFail && near.query && deptQuery(near.query);
      box.innerHTML = busy ? `<p class="muted">지도 정보 서버가 바빠서 진료과 목록을 못 받았어요. 잠시 뒤 <b>다시 찾기</b>를 눌러 주세요. 병원 이름으로 찾으면 바로 될 수 있어요.</p>`
        : near.query ? `<p class="muted">‘${esc(near.query)}’을(를) 근처에서 찾지 못했어요. 다른 이름이나 진료과로 찾아보세요.</p>` : `<p class="muted">가까운 곳을 찾지 못했어요.</p>`;
      return speak(busy ? "지도 서버가 바빠요. 잠시 뒤에 다시 찾아 주세요." : near.query ? "찾지 못했어요. 다른 이름으로 찾아보세요." : "가까운 곳을 찾지 못했어요.");
    }
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
        ${h.hours ? `<p class="muted" style="font-size:16px">🕘 ${esc(h.hours)}</p>` : ""}
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
    speak(`${near.query ? `${near.query}, ${L0.length}곳을 찾았어요. 가장 가까운 곳은` : `가장 가까운 ${near.kind === "er" ? "응급실은" : "병원은"}`} ${f.name}이에요. 여기서 ${distText(f.d).replace("km", "킬로미터").replace("m", "미터")}예요.${f.beds === 0 ? " 지금 응급실 빈 침대가 없다고 나와요. 전화로 먼저 물어보세요." : ""} 전화 버튼이나 길 안내 버튼을 누르세요.`);
  }
  function renderNear() {
    setStep(near.kind === "er" ? "🚑 가까운 응급실" : near.query ? `🔍 ‘${near.query}’ 검색` : "🏥 병원 찾기", "");
    main.innerHTML = `
      ${near.kind === "hosp" ? `
      <form id="hSearch" class="search" role="search">
        <input id="hq" type="search" enterkeyhint="search" placeholder="병원 이름·진료과 (예: 안과)" value="${esc(near.query || "")}" autocomplete="off">
        <button class="btn btn-primary" type="submit">🔍</button>
      </form>
      <div id="hSuggest" class="suggest" hidden></div>
      <div class="dept-chips">${DEPTS.map(d => `<button class="chip dept ${near.query === d ? "on" : ""}" data-dept="${d}">${d}</button>`).join("")}</div>` : ""}
      <div class="tabs" role="tablist">
        <button role="tab" class="tab ${near.kind === "er" ? "on" : ""}" data-k="er" aria-selected="${near.kind === "er"}">🚑 응급실</button>
        <button role="tab" class="tab ${near.kind === "hosp" ? "on" : ""}" data-k="hosp" aria-selected="${near.kind === "hosp"}">🏥 병원·의원</button>
      </div>
      ${near.kind === "er" ? `<p class="sign" style="font-size:18px">많이 위급하면 기다리지 말고 <b>119</b>에 전화하세요. 119가 알맞은 응급실로 데려다줘요.</p>` : ""}
      <div id="nearMap" class="map mini"></div>
      <div id="nearList" class="near-list"></div>
      <p class="muted" id="nearSrc" style="font-size:15px"></p>`;
    const keep = renderNear.keepList; renderNear.keepList = false;
    main.querySelectorAll("[data-k]").forEach(b => b.onclick = () => { near.kind = b.dataset.k; near.query = ""; renderNear(); });
    const doSearch = (q) => { near.query = (q || "").trim(); near.kind = "hosp"; renderNear(); };
    const hs = $("#hSearch");
    if (hs) {
      hs.onsubmit = (e) => { e.preventDefault(); $("#hq").blur(); $("#hSuggest").hidden = true; doSearch($("#hq").value); };
      const hq = $("#hq"), sg = $("#hSuggest");
      // 주변 병·의원 목록을 미리 모아 두면 글자 칠 때 바로 추천돼요
      if (nav.pos) healthPool(nav.pos, 0.03).catch(() => {});
      let tmr = 0;
      hq.oninput = () => {
        clearTimeout(tmr);
        tmr = setTimeout(() => {
          const list = deptQuery(hq.value) ? [] : nameSuggest(hq.value.trim());
          sg.innerHTML = ""; sg.hidden = !list.length;
          list.forEach(it => sg.append(btn(`🏥 ${esc(it.name)} <small>${nav.pos ? distText(distanceM(nav.pos, it)) : ""}</small>`, "suggest-item", () => {
            sg.hidden = true; near.query = it.name; near.kind = "hosp";
            near.list = [Object.assign(it, { d: nav.pos ? distanceM(nav.pos, it) : 0 })]; near.src = "주변 병원 목록";
            renderNear.keepList = true; renderNear();
          })));
        }, 200);
      };
      main.querySelectorAll("[data-dept]").forEach(b => b.onclick = () => doSearch(near.query === b.dataset.dept ? "" : b.dataset.dept));
    }
    const voiceSearch = btn("🎙 말로 찾기", "btn-talk", function () {
      listen(t => { const d = deptQuery(t); doSearch(d || cleanQuery(t).replace(/(근처|가까운|주변|찾아\s*줘|찾아\s*주세요|어디\s*있어|어디예요)/g, "").trim()); }, this);
    });
    dock.replaceChildren(
      ...(near.kind === "er" ? [btn("🚨 119 전화", "btn-xl btn-sos", openSOS)] : [voiceSearch]),
      row(btn(near.query ? "✖ 검색 지우기" : "🔄 다시 찾기", "btn-light", () => near.query ? doSearch("") : loadNear()), btn("⬅ 돌아가기", "btn-light", () => { near.query = ""; go(near.back || "home"); }))
    );
    if (keep && near.list.length && nav.pos) paintNear(nav.pos); else loadNear();
  }
  function openNear(kind, query) {
    if (state.screen !== "near") near.back = state.screen === "doctor" ? "talk" : state.screen;
    near.kind = kind || near.kind; near.query = query || ""; $("#sos").hidden = true; go("near");
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

  // ───────────────────────── 보호자 연결 · 알림 ─────────────────────────
  // 보호자 번호는 이 휴대폰에만 저장합니다. 알림은 어르신 휴대폰의 문자 앱으로 보내고,
  // 보내기 버튼은 어르신이 직접 누릅니다(웹앱은 몰래 문자를 보낼 수 없고, 보내지도 않습니다).
  const G = {
    list() { return store.get("guardians", []); },
    save(l) { store.set("guardians", l); },
    opts() { return Object.assign({ ask: true, start: true, bus: true, arrive: true, counter: true, doctor: true, help: true }, store.get("gopts", {})); },
    setOpt(k, v) { const o = G.opts(); o[k] = v; store.set("gopts", o); }
  };
  const G_EVENTS = [
    ["start", "🚶 길 안내를 시작할 때"],
    ["bus", "🚌 버스에서 내렸을 때"],
    ["arrive", "🏥 병원(목적지)에 도착했을 때"],
    ["counter", "✅ 창구에 도착했을 때"],
    ["doctor", "🩺 진료 메모를 정리했을 때"],
    ["help", "🙋 도움 요청 · 🚨 119를 눌렀을 때"]
  ];
  const fmtPhone = (n) => { const d = String(n).replace(/\D/g, ""); return d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d; };
  const validPhone = (n) => /^0\d{8,10}$/.test(String(n).replace(/\D/g, ""));
  function smsHref(num, body) {
    const n = String(num).replace(/\D/g, ""), b = encodeURIComponent(body);
    return isIOS ? `sms:${n}&body=${b}` : `sms:${n}?body=${b}`;
  }
  const nowText = () => new Date().toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
  function mapLink(p) { return p ? `https://map.kakao.com/link/map/%ED%98%84%EC%9E%AC%EC%9C%84%EC%B9%98,${p.lat.toFixed(5)},${p.lng.toFixed(5)}` : ""; }
  const notified = new Set(store.get("gsent", []));
  function markSent(key) { notified.add(key); store.set("gsent", [...notified]); }

  // 알림 판 띄우기: kind = 이벤트, text = 보낼 문장, force = 같은 여정에서 이미 보냈어도 다시 묻기
  async function notifyGuardians(kind, text, { force = false, urgent = false } = {}) {
    const list = G.list(), o = G.opts();
    if (!list.length || (!urgent && (!o.ask || !o[kind]))) return;
    const key = `${kind}:${state.outIdx}:${state.inIdx}:${state.dest ? state.dest.name : "preset"}`;
    if (!force && notified.has(key)) return;
    markSent(key);
    let p = nav.pos;
    if (!p && urgent) { await Promise.race([requestLocation(), new Promise(r => setTimeout(r, 4000))]); p = nav.pos; }
    const body = `[병원한걸음] ${text} (${nowText()})${p ? `\n지금 위치: ${mapLink(p)}` : ""}`;
    showGuardianSheet(body, urgent);
  }
  function showGuardianSheet(body, urgent) {
    const old = $("#gSheet"); if (old) old.remove();
    const list = G.list();
    const wrap = document.createElement("div");
    wrap.id = "gSheet"; wrap.className = "overlay sheet"; wrap.setAttribute("role", "dialog"); wrap.setAttribute("aria-modal", "true");
    wrap.innerHTML = `<div class="sheet-inner">
      <p class="big" style="font-size:26px">👪 ${urgent ? "보호자에게 바로 알리세요" : "보호자에게 알릴까요?"}</p>
      <p class="g-preview">${esc(body).replace(/\n/g, "<br>")}</p>
      <div class="g-btns"></div>
      <button class="btn btn-light" id="gLater">${urgent ? "닫기" : "괜찮아요 (안 보내기)"}</button>
    </div>`;
    const box = wrap.querySelector(".g-btns");
    list.forEach(g => {
      const r = document.createElement("div"); r.className = "row2";
      const a = document.createElement("a"); a.className = "btn btn-primary"; a.href = smsHref(g.phone, body); a.innerHTML = `📩 ${esc(g.name)}에게 문자`;
      a.onclick = () => setTimeout(() => wrap.remove(), 500);
      const c = document.createElement("a"); c.className = "btn btn-light"; c.href = "tel:" + String(g.phone).replace(/\D/g, ""); c.innerHTML = `📞 전화`;
      r.append(a, c); box.append(r);
    });
    if (navigator.share) box.append(btn("💬 카카오톡 등으로 보내기", "btn-light", async () => { try { await navigator.share({ text: body }); wrap.remove(); } catch {} }));
    wrap.querySelector("#gLater").onclick = () => wrap.remove();
    document.body.append(wrap);
    vibrate(urgent ? [200, 100, 200] : 60);
    const who = list.length === 1 ? list[0].name : "보호자";
    speak(urgent ? `${who}에게 문자를 보내거나 전화하세요.` : `${who}에게 문자로 알릴까요? 보내려면 초록 버튼을 누르세요.`);
  }

  // 보호자 등록 화면
  function renderGuardian() {
    setStep("👪 보호자 연결", "번호는 이 휴대폰에만 저장");
    const list = G.list(), o = G.opts();
    main.innerHTML = `
      <section class="card">
        <p class="big" style="font-size:26px">병원 가는 동안<br>가족에게 알려 드려요.</p>
        <p class="muted" style="margin-top:8px">출발·도착할 때 문자 보낼 준비를 해 드려요. <b>보내기 버튼은 직접 누르시면</b> 돼요.</p>
      </section>
      <section class="slots" id="gList">${list.length ? "" : '<p class="muted">아직 등록한 보호자가 없어요.</p>'}</section>
      ${list.length < 3 ? `
      <form class="card g-form" id="gForm">
        <p class="muted" style="margin:0">보호자 추가 (최대 3명)</p>
        <input id="gName" placeholder="부르는 이름 (예: 큰딸, 아들)" maxlength="12" autocomplete="off">
        <input id="gPhone" type="tel" inputmode="tel" placeholder="휴대폰 번호 (예: 010-1234-5678)" maxlength="13" autocomplete="off">
        ${"contacts" in navigator && "ContactsManager" in window ? '<button type="button" class="btn btn-light" id="gPick">📒 연락처에서 고르기</button>' : ""}
        <button class="btn btn-primary" type="submit">➕ 보호자 추가</button>
        <p class="muted" id="gErr" style="margin:0;color:var(--danger)"></p>
      </form>` : ""}
      <section class="card">
        <label class="field row"><input type="checkbox" id="gAsk" ${o.ask ? "checked" : ""}> 아래 순간마다 보호자에게 알릴지 물어보기</label>
        <div class="g-events">${G_EVENTS.map(([k, label]) => `<label class="field row"><input type="checkbox" data-ev="${k}" ${o[k] ? "checked" : ""}> ${label}</label>`).join("")}</div>
      </section>
      <p class="muted" style="font-size:16px">🔒 번호는 이 휴대폰 안에만 저장되고 어디에도 보내지 않아요. ‘처음부터 다시’를 눌러도 지워지지 않아요.</p>`;
    const gl = $("#gList");
    list.forEach((g, i) => {
      const el = document.createElement("div"); el.className = "slot";
      el.innerHTML = `<div><div class="v">👤 ${esc(g.name)}</div><div class="k">${esc(fmtPhone(g.phone))}</div></div>`;
      const acts = document.createElement("div"); acts.className = "g-acts";
      const t = document.createElement("a"); t.className = "edit"; t.href = "tel:" + g.phone.replace(/\D/g, ""); t.textContent = "📞"; t.setAttribute("aria-label", g.name + "에게 전화");
      acts.append(t, btn("🗑", "edit", () => { if (confirm(`${g.name} 번호를 지울까요?`)) { const l = G.list(); l.splice(i, 1); G.save(l); renderGuardian(); } }, { ariaLabel: g.name + " 지우기" }));
      el.append(acts); gl.append(el);
    });
    const form = $("#gForm");
    if (form) {
      form.onsubmit = (e) => {
        e.preventDefault();
        const name = $("#gName").value.trim() || "보호자", phone = $("#gPhone").value.trim();
        if (!validPhone(phone)) { $("#gErr").textContent = "휴대폰 번호를 다시 확인해 주세요. (예: 010-1234-5678)"; return speak("휴대폰 번호를 다시 확인해 주세요."); }
        const l = G.list(); l.push({ name, phone: phone.replace(/\D/g, "") }); G.save(l);
        speak(`${name} 번호를 저장했어요.`); renderGuardian();
      };
      const pick = $("#gPick");
      if (pick) pick.onclick = async () => {
        try {
          const [c] = await navigator.contacts.select(["name", "tel"], { multiple: false });
          if (c) { $("#gName").value = (c.name && c.name[0]) || ""; $("#gPhone").value = (c.tel && c.tel[0]) || ""; }
        } catch {}
      };
    }
    liveSection(main);
    $("#gAsk").onchange = (e) => G.setOpt("ask", e.target.checked);
    main.querySelectorAll("[data-ev]").forEach(c => c.onchange = () => G.setOpt(c.dataset.ev, c.checked));
    dock.replaceChildren(
      ...(list.length ? [btn("📩 시험 문자 보내 보기", "btn-xl btn-primary", () => notifyGuardians("test", "병원한걸음 보호자 알림 시험이에요. 병원 갈 때 이렇게 알려 드려요.", { force: true, urgent: true }))] : []),
      btn("⬅ 돌아가기", "btn-light", () => go(G.back || "home"))
    );
    if (!list.length) speak("가족 번호를 등록하면, 병원 가는 동안 출발하고 도착할 때마다 문자로 알릴 수 있어요.");
  }
  function openGuardian() { if (state.screen !== "guardian") G.back = state.screen; $("#settings").hidden = true; $("#sos").hidden = true; go("guardian"); }

  // ───────────────────────── 화면 이동 공통 (돌아갈 곳 기억) ─────────────────────────
  const backOf = {};
  function openScreen(name) {
    if (state.screen !== name) backOf[name] = ["lang", "taxi", "plan", "where"].includes(state.screen) ? (backOf[state.screen] || "home") : state.screen;
    ["#settings", "#sos", "#helpCard"].forEach(id => { const el = $(id); if (el) el.hidden = true; });
    const gs = $("#gSheet"); if (gs) gs.remove();
    go(name);
  }
  const backBtnTo = (name) => btn("⬅ 돌아가기", "btn-light", () => go(backOf[name] || "home"));

  // ───────────────────────── 11. 외국어 카드 · 필담 ─────────────────────────
  const LANGS = {
    en: { label: "English", tts: "en-US" },
    zh: { label: "中文", tts: "zh-CN" },
    vi: { label: "Tiếng Việt", tts: "vi-VN" },
    ja: { label: "日本語", tts: "ja-JP" },
    ru: { label: "Русский", tts: "ru-RU" }
  };
  const PHRASES = [
    { ko: "처음 왔어요. 접수를 도와주세요.", en: "This is my first visit. Please help me register.", zh: "我是第一次来。请帮我挂号。", vi: "Tôi đến lần đầu. Xin giúp tôi đăng ký khám.", ja: "初めて来ました。受付を手伝ってください。", ru: "Я здесь впервые. Помогите мне, пожалуйста, зарегистрироваться." },
    { ko: "길을 잃었어요. 처음오신 창구가 어디예요?", en: "I am lost. Where is the first-visit desk?", zh: "我迷路了。初诊窗口在哪里？", vi: "Tôi bị lạc. Quầy dành cho người khám lần đầu ở đâu?", ja: "道に迷いました。初診の窓口はどこですか？", ru: "Я заблудился. Где регистратура для первичных пациентов?" },
    { ko: "한국어를 잘 못해요. 통역이 필요해요.", en: "I don't speak Korean well. I need an interpreter.", zh: "我韩语不好。我需要翻译。", vi: "Tôi không giỏi tiếng Hàn. Tôi cần phiên dịch.", ja: "韓国語がうまく話せません。通訳が必要です。", ru: "Я плохо говорю по-корейски. Мне нужен переводчик." },
    { ko: "예약했어요. 진료실이 어디예요?", en: "I have an appointment. Where is the doctor's office?", zh: "我有预约。诊室在哪里？", vi: "Tôi đã đặt lịch hẹn. Phòng khám ở đâu?", ja: "予約しています。診察室はどこですか？", ru: "У меня запись к врачу. Где кабинет?" },
    { ko: "수납은 어디에서 해요?", en: "Where do I pay?", zh: "在哪里缴费？", vi: "Tôi thanh toán ở đâu?", ja: "会計はどこですか？", ru: "Где можно оплатить?" },
    { ko: "화장실이 어디예요?", en: "Where is the restroom?", zh: "洗手间在哪里？", vi: "Nhà vệ sinh ở đâu?", ja: "トイレはどこですか？", ru: "Где туалет?" },
    { ko: "몸이 많이 아파요. 도와주세요.", en: "I feel very sick. Please help me.", zh: "我很不舒服。请帮帮我。", vi: "Tôi rất đau. Xin hãy giúp tôi.", ja: "とても具合が悪いです。助けてください。", ru: "Мне очень плохо. Помогите, пожалуйста." },
    { ko: "보행기를 써요. 엘리베이터가 어디예요?", en: "I use a walker. Where is the elevator?", zh: "我用助行器。电梯在哪里？", vi: "Tôi dùng khung tập đi. Thang máy ở đâu?", ja: "歩行器を使っています。エレベーターはどこですか？", ru: "Я хожу с ходунками. Где лифт?" }
  ];
  const DEAF = [
    "귀가 잘 안 들려요. 글로 써 주세요.",
    "천천히, 입 모양이 보이게 말씀해 주세요.",
    "수어 통역이 필요해요.",
    "제 이름이 불리면 어깨를 살짝 두드려 주세요."
  ];
  function showBigCard(ko, sub, readLang) {
    const card = $("#helpCard");
    $("#helpText").innerHTML = esc(ko) + (sub ? `<span class="help-sub">${esc(sub)}</span>` : "");
    card.hidden = false;
    const hg = $("#helpGuardian"); if (hg) hg.hidden = true;
    speak(ko, { force: true });
    if (readLang && sub) window.addEventListener("hg:spoken", () => speak(sub, { force: true, lang: readLang }), { once: true });
  }
  function renderLang() {
    const cur = store.get("lang2", "en");
    setStep("🌐 외국어 · 필담", "직원에게 보여 주는 카드");
    main.innerHTML = `
      <section class="card"><p class="muted" style="margin:0">내 말을 고르세요 · Choose your language</p>
        <div class="lang-tabs">${Object.entries(LANGS).map(([k, v]) => `<button class="tab ${k === cur ? "on" : ""}" data-lang="${k}">${v.label}</button>`).join("")}
        <button class="tab ${cur === "deaf" ? "on" : ""}" data-lang="deaf">🧏 필담</button></div></section>
      <section class="phrases" id="phrases"></section>`;
    main.querySelectorAll("[data-lang]").forEach(b => b.onclick = () => { store.set("lang2", b.dataset.lang); renderLang(); });
    const box = $("#phrases");
    if (cur === "deaf") {
      box.innerHTML = `
        <section class="card">
          <p class="muted" style="margin:0 0 8px">직원분이 쓰거나, 제가 써서 보여 드려요</p>
          <textarea id="penBox" rows="4" placeholder="여기에 써 주세요"></textarea>
          <div class="row2" style="margin-top:10px"></div>
        </section>`;
      const r2 = box.querySelector(".row2"), pen = $("#penBox");
      r2.append(
        btn("🔍 크게 보기", "btn-primary", () => pen.value.trim() && showBigCard(pen.value.trim())),
        btn("🎙 직원 말 → 글자", "btn-talk", function () { listen(t => { pen.value = (pen.value ? pen.value + "\n" : "") + t; }, this); })
      );
      box.append(btn("🗑 지우기", "btn-light", () => { pen.value = ""; pen.focus(); }));
      DEAF.forEach(t => box.append(btn(t, "btn-light phrase", () => showBigCard(t))));
    } else {
      PHRASES.forEach(p => box.append(btn(`<span class="ph-main">${esc(p[cur])}</span><span class="ph-ko">${esc(p.ko)}</span>`, "btn-light phrase", () => showBigCard(p.ko, p[cur], LANGS[cur].tts))));
    }
    dock.replaceChildren(backBtnTo("lang"));
  }

  // ───────────────────────── 7. 택시 · 교통약자 콜택시 ─────────────────────────
  function taxiDest() {
    if (!isPreset() && state.dest) return { name: state.dest.name, lat: state.dest.lat, lng: state.dest.lng, door: `${state.dest.name} 정문` };
    const h = RT().outdoor[RT().outdoor.length - 1];
    return { name: "분당서울대학교병원", lat: h.lat, lng: h.lng, door: "분당서울대학교병원 1동 정문", addr: "성남시 분당구 구미로173번길 82" };
  }
  function renderTaxi() {
    const d = taxiDest(), m = state.slots.mobility, T = R.taxi || {};
    setStep("🚕 택시 타기", "기사님께 화면을 보여 주세요");
    main.innerHTML = `
      <section class="help-mini taxi-card">
        <p class="help-small">기사님께 보여 드리세요</p>
        <p class="help-q">“${esc(d.door)}으로 가 주세요.”</p>
        ${d.addr ? `<p class="muted" style="color:#5b4a00">주소: ${esc(d.addr)}</p>` : ""}
        ${m === "보행기" ? '<p class="help-q" style="font-size:22px">보행기를 트렁크에 실어 주세요.</p>' : m === "휠체어" ? '<p class="help-q" style="font-size:22px">휠체어를 써요. 타고 내릴 때 도와주세요.</p>' : ""}
        <p class="help-q" style="font-size:22px">천천히 가 주세요. 감사합니다.</p>
      </section>
      <section class="card">
        <p class="muted" style="margin:0 0 6px">휠체어·보행기라 일반 택시가 어려우면</p>
        <p style="margin:0;font-size:20px"><b>${esc(T.name || "교통약자 콜택시")}</b>${T.note ? `<br><small class="muted">${esc(T.note)}</small>` : ""}</p>
      </section>`;
    const r = document.createElement("div"); r.className = "row2";
    const kakao = document.createElement("a"); kakao.className = "btn btn-talk"; kakao.href = "kakaot://taxi"; kakao.innerHTML = "🚕 카카오 T 열기";
    kakao.onclick = () => setTimeout(() => { if (!document.hidden) speak("카카오 T 앱이 없으면, 앱 스토어에서 카카오 티를 설치해 주세요. 아래 콜택시 전화도 있어요.", { force: true }); }, 1800);
    r.append(kakao);
    if (T.phone) { const c = document.createElement("a"); c.className = "btn btn-light"; c.href = "tel:" + T.phone.replace(/\D/g, ""); c.innerHTML = `♿ ${esc(T.phone)}`; r.append(c); }
    main.append(r);
    if (G.list().length) main.append(btn("👪 택시 탄다고 보호자에게 알리기", "btn-light", () => notifyGuardians("start", `택시를 타고 ${d.name}에 가요.`, { force: true, urgent: true })));
    dock.replaceChildren(btn("🔊 기사님께 읽어 드리기", "btn-xl btn-primary", () => speak(`${d.door}으로 가 주세요.${m === "보행기" ? " 보행기를 트렁크에 실어 주세요." : m === "휠체어" ? " 휠체어를 써요. 타고 내릴 때 도와주세요." : ""} 천천히 가 주세요. 감사합니다.`, { force: true })), backBtnTo("taxi"));
    speak("택시를 타시면 이 화면을 기사님께 보여 드리세요. 카카오 티로 부르거나, 휠체어와 보행기용 콜택시에 전화할 수 있어요.");
  }

  // ───────────────────────── 8. 출발 시간 계산 ─────────────────────────
  const WALK = 0.6; // 어르신 걷는 속도 (m/초) ≈ 시속 2.2km
  function parseKoTime(t) {
    const n = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 열한: 11, 열두: 12 };
    const m = t.replace(/\s/g, "").match(/(오전|오후|아침|낮|저녁)?(\d{1,2}|열한|열두|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)시(반|(\d{1,2})분)?/);
    if (!m) return null;
    let h = /\d/.test(m[2]) ? +m[2] : n[m[2]];
    const min = m[3] === "반" ? 30 : m[4] ? +m[4] : 0;
    if ((m[1] === "오후" || m[1] === "저녁" || m[1] === "낮") && h < 12) h += 12;
    if (!m[1] && h >= 1 && h <= 6) h += 12;            // "3시" 진료는 보통 오후
    const day = /모레/.test(t) ? 2 : /내일/.test(t) ? 1 : 0;
    return { h, min, day };
  }
  function planSteps(first) {
    const O = RT().outdoor, out = [];
    if (isPreset()) {
      out.push(["🏠 집 → 미금역", +store.get("homeMin", 15)]);
      out.push(["🚶 역 엘리베이터 → 정류장", Math.ceil(distanceM(O[0], O[1]) / WALK / 60) + 3]);
      out.push(["⏳ 7-1번 기다리기", 15]);
      out.push(["🚌 7-1번 타고 가기 (3정거장)", 10]);
      out.push(["🚶 정류장 → 1동 입구", Math.ceil(distanceM(O[2], O[3]) / WALK / 60) + 3]);
      out.push(["🏥 1동 → 창구 · 접수", 15]);
    } else {
      const from = nav.pos || O[0];
      const d = distanceM(from, O[0]);
      out.push([d > 1500 ? `🚕 지금 위치 → ${state.dest.name} (택시·버스 권장)` : `🚶 지금 위치 → ${state.dest.name}`, Math.ceil((d > 1500 ? d / 5 : d / WALK) / 60) + 10]);
      out.push(["🏥 접수", 15]);
    }
    if (first) out.push(["🕐 처음 방문이라 일찍 도착", 20]);
    return out;
  }
  const hm = (d) => d.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
  const md = (d) => d.toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
  function makeIcs(appt, leave, place) {
    const f = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const uid = "hg-" + appt.getTime() + "@hangeoreum";
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//hangeoreum//KO", "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${f(new Date())}`,
      `DTSTART:${f(leave)}`, `DTEND:${f(appt)}`, `SUMMARY:병원 가는 날 - ${hm(leave)} 출발`, `LOCATION:${place}`,
      `DESCRIPTION:${hm(appt)} 진료. 병원한걸음 앱을 열고 길 안내를 시작하세요.`,
      "BEGIN:VALARM", "TRIGGER:-PT30M", "ACTION:DISPLAY", "DESCRIPTION:30분 뒤 병원 갈 준비", "END:VALARM",
      "BEGIN:VALARM", "TRIGGER:PT0M", "ACTION:DISPLAY", "DESCRIPTION:지금 출발하세요", "END:VALARM",
      "BEGIN:VALARM", "TRIGGER:-P1D", "ACTION:DISPLAY", "DESCRIPTION:내일 병원 가는 날", "END:VALARM",
      "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  }
  function renderPlan() {
    setStep("⏰ 언제 나갈까요?", "진료 시간으로 계산");
    const saved = store.get("plan", null);
    const now = new Date(), def = saved ? new Date(saved.appt) : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 10, 0);
    const pad = (n) => String(n).padStart(2, "0");
    main.innerHTML = `
      <section class="card">
        <p class="big" style="font-size:26px">진료가 몇 시예요?</p>
        <div class="plan-inputs">
          <label class="field">날짜<input type="date" id="pDate" value="${def.getFullYear()}-${pad(def.getMonth() + 1)}-${pad(def.getDate())}"></label>
          <label class="field">시간<input type="time" id="pTime" value="${pad(def.getHours())}:${pad(def.getMinutes())}"></label>
        </div>
        ${isPreset() ? `<label class="field" style="margin-top:8px">집에서 미금역까지 (분)<input type="number" id="pHome" min="0" max="120" value="${store.get("homeMin", 15)}" inputmode="numeric"></label>` : ""}
        <label class="field row" style="margin-top:8px"><input type="checkbox" id="pFirst" ${state.slots.firstVisit !== false ? "checked" : ""}> 처음 가는 병원이에요</label>
      </section>
      <section class="card" id="planOut"></section>`;
    const calc = () => {
      const [y, mo, da] = $("#pDate").value.split("-").map(Number), [hh, mm] = $("#pTime").value.split(":").map(Number);
      if (!y || hh == null) return;
      if ($("#pHome")) store.set("homeMin", Math.max(0, +$("#pHome").value || 0));
      const appt = new Date(y, mo - 1, da, hh, mm), steps = planSteps($("#pFirst").checked);
      const total = steps.reduce((a, [, m]) => a + m, 0), leave = new Date(appt - total * 60000);
      store.set("plan", { appt: appt.getTime(), leave: leave.getTime(), place: taxiDest().name });
      let t = new Date(leave);
      $("#planOut").innerHTML = `
        <p class="muted" style="margin:0">${md(appt)} ${hm(appt)} 진료라면</p>
        <p class="plan-leave">${hm(leave)}에<br>집에서 나가세요</p>
        <ol class="plan-list">${steps.map(([label, m]) => { const s0 = hm(t); t = new Date(t.getTime() + m * 60000); return `<li><b>${s0}</b> ${esc(label)} <small>${m}분</small></li>`; }).join("")}
        <li><b>${hm(appt)}</b> 🩺 진료</li></ol>
        <p class="muted" style="font-size:15px;margin:6px 0 0">어르신 걸음(시속 약 2km)과 버스 기다리는 시간 15분을 넣어 넉넉히 계산했어요.</p>`;
      return { appt, leave };
    };
    ["#pDate", "#pTime", "#pHome", "#pFirst"].forEach(id => { const el = $(id); if (el) el.onchange = el.oninput = calc; });
    let r = calc();
    const talkB = btn("🎙 말로 하기 (예: 내일 10시 반)", "btn-talk", function () {
      listen(t => {
        const p = parseKoTime(t); if (!p) return speak("시간을 못 알아들었어요. 예를 들어, 내일 열 시 반, 처럼 말씀해 주세요.");
        const d = new Date(); d.setDate(d.getDate() + p.day);
        $("#pDate").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; $("#pTime").value = `${pad(p.h)}:${pad(p.min)}`;
        r = calc(); sayPlan();
      }, this);
    });
    const sayPlan = () => { r = calc(); if (r) speak(`${md(r.appt)} ${hm(r.appt)} 진료라면, ${hm(r.leave)}에 집에서 나가세요.`, { force: true }); };
    const ics = btn("📅 달력에 알림 넣기", "btn-light", () => {
      r = calc(); if (!r) return;
      const blob = new Blob([makeIcs(r.appt, r.leave, taxiDest().door || taxiDest().name)], { type: "text/calendar" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "병원가는날.ics"; document.body.append(a); a.click(); a.remove();
      speak("달력에 넣는 파일을 만들었어요. 열어서 추가를 눌러 주세요. 하루 전, 30분 전, 나갈 때 알려 드려요.", { force: true });
    });
    main.append(talkB);
    const extra = [row(ics, btn("🔊 들려주기", "btn-light", sayPlan))];
    if (G.list().length) extra.push(btn("👪 보호자에게 일정 알리기", "btn-light", () => { r = calc(); notifyGuardians("start", `${md(r.appt)} ${hm(r.appt)}에 ${taxiDest().name} 진료가 있어요. ${hm(r.leave)}에 출발할게요.`, { force: true, urgent: true }); }));
    dock.replaceChildren(btn("✅ 이대로 할게요", "btn-xl btn-primary", () => { sayPlan(); go(backOf.plan || "home"); }), ...extra);
    sayPlan();
  }
  function planBanner() {
    const p = store.get("plan", null); if (!p) return "";
    const appt = new Date(p.appt), leave = new Date(p.leave);
    if (appt < new Date()) return "";
    return `<button class="card plan-banner" id="planBanner">⏰ <b>${md(appt)} ${hm(appt)}</b> 진료 · <b>${hm(leave)}</b>에 출발</button>`;
  }

  // ───────────────────────── 1. 사진으로 "여기가 어디예요?" ─────────────────────────
  const SIGN_HINTS = [
    [/처음\s*오신|초진|첫\s*방문/, "‘처음오신 분’ 표지판이에요. 이 표지판 화살표 방향으로 가세요."],
    [/1\s*동/, "1동이라고 쓰여 있어요. 분당서울대병원 1동 근처예요."],
    [/엘리베이터|승강기|elevator/i, "엘리베이터 표지판이에요. 보행기·휠체어는 엘리베이터를 이용하세요."],
    [/수납|원무/, "수납 창구 표지판이에요. 진료가 끝나면 여기서 돈을 내요."],
    [/약국|약제/, "약국 표지판이에요."],
    [/응급/, "응급실 표지판이에요."],
    [/화장실|toilet|restroom/i, "화장실 표지판이에요."],
    [/출구|나가는|exit/i, "나가는 곳 표지판이에요."],
    [/미금역|3\s*번\s*출구/, "미금역 3번 출구 근처예요. 마을버스 정류장은 가까이 있어요."],
    [/7\s*-\s*1|서울대병원/, "7-1번 또는 서울대병원 글자가 보여요. 버스 정류장이 맞아요."],
    [/접수|외래/, "접수·외래 표지판이에요."]
  ];
  let tessLoading = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    if (tessLoading) return tessLoading;
    tessLoading = new Promise((ok, no) => {
      const sc = document.createElement("script");
      sc.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
      sc.onload = ok; sc.onerror = no; document.head.append(sc);
    });
    return tessLoading;
  }
  async function shrinkImage(file, max = 1280) {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = URL.createObjectURL(file); });
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  async function readPhoto(file) {
    const out = $("#whereOut");
    out.innerHTML = `<p class="big" style="font-size:24px">사진을 읽는 중이에요…</p><p class="muted" id="ocrProg"></p>`;
    speak("사진을 읽는 중이에요. 잠깐만 기다려 주세요.");
    const canvas = await shrinkImage(file);
    $("#wherePreview").src = canvas.toDataURL("image/jpeg", 0.8); $("#wherePreview").hidden = false;
    const ctx = state.screen === "where" ? (backOf.where === "indoor" ? "분당서울대병원 1동 안, 처음오신 창구를 찾는 중" : backOf.where === "outdoor" ? `${RT().outdoor[state.outIdx] ? RT().outdoor[state.outIdx].place : ""}(으)로 가는 중` : "") : "";
    // 1순위: 서버 AI (사진 이해)
    if (server.ai) {
      try {
        const r = await fetch("api/vision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: canvas.toDataURL("image/jpeg", 0.7), context: ctx }) });
        if (r.ok) { const j = await r.json(); return showWhere(j.answer, j.text || ""); }
      } catch {}
    }
    // 2순위: 휴대폰 안에서 글자 읽기 (처음 한 번 글자 사전을 내려받아요)
    try {
      await loadTesseract();
      const res = await Tesseract.recognize(canvas, "kor+eng", { logger: m => { const p = $("#ocrProg"); if (p && m.progress != null) p.textContent = `${m.status === "recognizing text" ? "글자 읽는 중" : "준비 중"} ${Math.round(m.progress * 100)}%`; } });
      const text = (res.data.text || "").replace(/[^\S\n]+/g, " ").split("\n").map(x => x.trim()).filter(x => x.length > 1).join("\n");
      const hints = SIGN_HINTS.filter(([re]) => re.test(text)).map(([, h]) => h);
      const answer = hints.length ? hints.slice(0, 2).join(" ") : text ? "표지판 글자를 읽었어요. 아래 글자를 확인해 보세요." : "글자를 찾지 못했어요. 표지판을 가까이서, 흔들리지 않게 다시 찍어 주세요.";
      showWhere(answer, text);
    } catch {
      showWhere("사진을 읽지 못했어요. 인터넷 연결을 확인하거나, 도움 요청 버튼으로 직원분께 물어보세요.", "");
    }
  }
  function showWhere(answer, text) {
    const out = $("#whereOut"); if (!out) return;
    out.innerHTML = `<p class="big" style="font-size:26px">${esc(answer)}</p>${text ? `<p class="muted" style="margin:10px 0 0">읽은 글자</p><p class="ocr-text">${esc(text).replace(/\n/g, "<br>")}</p>` : ""}`;
    speak(answer + (text && text.length < 60 ? ` 표지판에는, ${text.replace(/\n/g, ", ")}, 라고 쓰여 있어요.` : ""), { force: true });
  }
  function renderWhere() {
    setStep("📷 여기가 어디예요?", "표지판·간판을 찍어 주세요");
    main.innerHTML = `
      <section class="card"><p class="big" style="font-size:26px">주변 표지판이나 간판을<br>사진으로 찍어 주세요.</p>
        <p class="muted" style="margin-top:6px">${server.ai ? "AI가 사진을 보고 어디인지 알려 드려요." : "휴대폰이 글자를 읽어 드려요. 처음 한 번은 글자 사전을 내려받느라 조금 걸려요."}</p></section>
      <img id="wherePreview" class="where-img" alt="찍은 사진" hidden>
      <section class="card" id="whereOut"><p class="muted">아직 사진이 없어요.</p></section>
      <input type="file" id="whereFile" accept="image/*" capture="environment" hidden>`;
    const f = $("#whereFile");
    f.onchange = () => { if (f.files[0]) readPhoto(f.files[0]); f.value = ""; };
    dock.replaceChildren(btn("📷 사진 찍기", "btn-xl btn-talk", () => f.click()), row(helpBtn(), backBtnTo("where")));
    speak("주변의 표지판이나 간판을 사진으로 찍어 주세요. 어디인지 알려 드릴게요.");
  }

  // ───────────────────────── 12. 보호자 실시간 위치 보기 (암호화) ─────────────────────────
  // 위치는 휴대폰에서 암호화해서 ntfy.sh(무료 알림 중계)에 올리고, 열쇠는 링크의 # 뒤에만 있어서 중계 서버도 못 읽어요.
  const LIVE = { timer: null, watch: null, last: null, lastAt: 0 };
  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const ub64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
  async function liveKey() {
    let k = store.get("liveKey", null);
    if (!k) {
      const topic = "hg" + b64u(crypto.getRandomValues(new Uint8Array(18))).replace(/[-_]/g, "x");
      const raw = await crypto.subtle.exportKey("raw", await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]));
      k = { topic, key: b64u(raw) }; store.set("liveKey", k);
    }
    return k;
  }
  async function liveLink() {
    const k = await liveKey();
    return new URL(`family.html#${k.topic}.${k.key}`, location.href).href;
  }
  async function livePublish(force) {
    if (!nav.pos) return;
    const now = Date.now();
    if (!force && LIVE.last && distanceM(LIVE.last, nav.pos) < 15 && now - LIVE.lastAt < 60000) return;
    const k = await liveKey();
    const where = state.screen === "outdoor" ? `${RT().outdoor[state.outIdx] ? RT().outdoor[state.outIdx].place : ""}(으)로 가는 중`
      : state.screen === "indoor" ? "병원 안 · 창구 찾는 중" : state.screen === "done" ? "도착했어요" : state.screen === "doctor" ? "진료 중" : "";
    const msg = JSON.stringify({ lat: +nav.pos.lat.toFixed(6), lng: +nav.pos.lng.toFixed(6), acc: Math.round(nav.acc || 0), t: now, where, dest: taxiDest().name });
    const key = await crypto.subtle.importKey("raw", ub64u(k.key), "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(msg));
    try {
      await fetch(`https://ntfy.sh/${k.topic}`, { method: "POST", body: b64u(iv) + "." + b64u(ct) });
      LIVE.last = { ...nav.pos }; LIVE.lastAt = now;
      const st = $("#liveState"); if (st) st.textContent = `마지막으로 보낸 시각 ${hm(new Date(now))}`;
    } catch {}
  }
  function liveStart() {
    store.set("liveOn", { until: Date.now() + 6 * 3600 * 1000 });
    document.body.classList.add("sharing");
    if ("geolocation" in navigator && LIVE.watch == null)
      LIVE.watch = navigator.geolocation.watchPosition(p => { nav.pos = { lat: p.coords.latitude, lng: p.coords.longitude }; nav.acc = p.coords.accuracy; livePublish(); }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
    clearInterval(LIVE.timer); LIVE.timer = setInterval(() => {
      const on = store.get("liveOn", null);
      if (!on || Date.now() > on.until) return liveStop();
      livePublish();
    }, 30000);
    setTimeout(() => livePublish(true), 1500);
  }
  function liveStop() {
    store.set("liveOn", null); document.body.classList.remove("sharing");
    clearInterval(LIVE.timer); LIVE.timer = null;
    if (LIVE.watch != null) navigator.geolocation.clearWatch(LIVE.watch); LIVE.watch = null;
  }
  async function liveSection(container) {
    const on = !!store.get("liveOn", null);
    const sec = document.createElement("section"); sec.className = "card";
    sec.innerHTML = `<p class="sum-title" style="font-size:22px">📡 실시간 위치 보여 주기</p>
      <p class="muted" style="margin:4px 0 8px">켜 두면 보호자가 링크로 지금 어디쯤인지 지도에서 봐요. 위치는 <b>암호화</b>되어 보호자 링크로만 열려요. 6시간 뒤 자동으로 꺼져요.</p>
      <p class="muted" id="liveState" style="margin:0 0 8px">${on ? "켜져 있어요" : "꺼져 있어요"}</p>`;
    const r = document.createElement("div"); r.className = "row2";
    r.append(
      on ? btn("⏹ 공유 끄기", "btn-light", () => { liveStop(); speak("위치 보여 주기를 껐어요."); renderGuardian(); })
         : btn("▶ 공유 켜기", "btn-primary", async () => { const lr = await requestLocation(); if (lr !== "granted") return speak("위치를 켜야 보여 줄 수 있어요."); liveStart(); speak("위치 보여 주기를 켰어요. 보호자에게 링크를 보내 주세요."); renderGuardian(); }),
      btn("🔗 보호자에게 링크 보내기", "btn-light", async () => notifyGuardians("help", `내 위치를 지도에서 볼 수 있는 링크예요. 이 링크는 다른 사람에게 보내지 마세요.\n${await liveLink()}`, { force: true, urgent: true }))
    );
    sec.append(r);
    sec.append(btn("🔄 링크 새로 만들기 (예전 링크 막기)", "btn-light", () => { if (confirm("새 링크를 만들면 예전 링크로는 더 이상 볼 수 없어요. 만들까요?")) { store.set("liveKey", null); speak("새 링크를 만들었어요. 보호자에게 다시 보내 주세요."); renderGuardian(); } }));
    container.append(sec);
  }
  if (store.get("liveOn", null) && Date.now() < store.get("liveOn").until) liveStart();

  // ───────────────────────── 3. 대화 모드 (말로만) ─────────────────────────
  const CMD = [
    [/119|응급(?!실)|숨이|가슴이|쓰러|많이\s*아파/, () => openSOS()],
    [/다시|뭐라고|못\s*들었|한\s*번\s*더/, () => speak(state.lastSaid, { force: true })],
    [/도와|길을?\s*잃|모르겠|헤매/, () => openHelp()],
    [/버스.*(언제|몇\s*분|와|오)|몇\s*분\s*(뒤|남)/, () => sayBus()],
    [/(다\s*왔|도착|내렸|탔어|했어|다음|됐어)/, () => cmdNext()],
    [/이전|뒤로|돌아가/, () => cmdBack()],
    [/여기.*어디|어디야|어디예요|어디에요|사진/, () => openScreen("where")],
    [/택시/, () => openScreen("taxi")],
    [/몇\s*시에?\s*(나가|출발)|출발\s*시간|언제\s*나가/, () => openScreen("plan")],
    [/약국/, () => openNear("hosp", "약국")],
    [/(내과|정형외과|안과|이비인후과|치과|피부과|한의원|가정의학과|재활의학과|신경과|비뇨|산부인과|소아과|소아청소년과)/, (t) => openNear("hosp", deptQuery(t) || t.replace(/\s*(찾아\s*줘|찾아\s*주세요|어디\s*있어|가고\s*싶어)\s*$/, "").trim())],
    [/병원.*(검색|찾아)|검색/, () => openNear("hosp")],
    [/응급실/, () => openNear("er")],
    [/병원.*(찾|가까운|근처)|가까운\s*병원/, () => openNear("hosp")],
    [/진료\s*메모|받아\s*적|선생님\s*말씀/, () => openDoctor()],
    [/딸|아들|보호자|가족|연락/, () => notifyGuardians("help", "연락 주세요. 지금 병원 가는 중이에요.", { force: true, urgent: true })],
    [/영어|중국어|베트남|일본어|외국어|필담|안\s*들려/, () => openScreen("lang")],
    [/소리\s*(꺼|끄)|조용/, () => { state.sound = false; save(); paintSound(); }],
    [/소리\s*(켜|크게)/, () => { state.sound = true; save(); paintSound(); speak("소리를 켰어요."); }],
    [/처음\s*(으로|화면)|홈/, () => go("home")]
  ];
  function cmdNext() {
    if (state.screen === "outdoor") return nextOutdoor();
    if (state.screen === "indoor") { state.inIdx++; save(); return renderIndoor(); }
    const b = dock.querySelector(".btn-primary, .btn-xl"); if (b) b.click();
  }
  function cmdBack() { const b = [...document.querySelectorAll("button")].find(x => /이전|돌아가기/.test(x.textContent)); if (b) b.click(); }
  async function sayBus() {
    const st = RT().outdoor.find(x => x.bus);
    if (!st || busBase() === null) return speak("지금은 버스 도착 정보를 볼 수 없어요. 정류장 안내판을 봐 주세요.", { force: true });
    try {
      const j = await (await fetch(`${busBase()}api/bus?stationId=${st.bus.stationId}`)).json();
      const m = (j.items || []).find(x => String(x.routeId) === String(st.bus.routeId));
      speak(m && m.buses.length ? `${st.bus.routeName}번 버스는 약 ${m.buses[0].min}분 뒤에 와요.` : `${st.bus.routeName}번은 지금 오는 버스가 없어요. 정류장에서 출발을 기다리는 버스예요.`, { force: true });
    } catch { speak("버스 정보를 가져오지 못했어요.", { force: true }); }
  }
  function runCommand(t) {
    const hit = CMD.find(([re]) => re.test(t.replace(/\s+/g, " ")));
    if (hit) { vibrate(40); hit[1](t); return true; }
    // 화면 안 버튼 글자와 비슷하면 눌러 주기
    const words = t.replace(/\s/g, "");
    const b = [...document.querySelectorAll("#dock button, #main button")].find(x => { const l = x.textContent.replace(/[^\p{L}\p{N}]/gu, ""); return l.length > 1 && (words.includes(l.slice(0, 4)) || l.includes(words.slice(0, 4))); });
    if (b) { b.click(); return true; }
    if (state.screen === "talk" || state.screen === "confirm") { handleUtterance(t); return true; }
    speak("잘 못 알아들었어요. 다 왔어요, 버스 언제 와, 도와줘, 처럼 말씀해 주세요.", { force: true });
    return false;
  }
  const fab = document.createElement("button");
  fab.id = "fab"; fab.className = "fab"; fab.setAttribute("aria-label", "말로 하기"); fab.innerHTML = "🎙";
  document.body.append(fab);
  fab.onclick = () => listen(runCommand, fab, { prompt: "무엇을 도와드릴까요?\n예) “다 왔어요” · “버스 언제 와” · “도와줘”" });
  new ResizeObserver(() => document.documentElement.style.setProperty("--dockH", dock.offsetHeight + "px")).observe(dock);
  // 계속 듣기: 안내 말이 끝나면 자동으로 다시 들음
  const HF = { on: store.get("handsfree", false), busy: false };
  function hfListen() {
    if (!HF.on || activeRec || !SR || document.hidden) return;
    if ($("#typeSheet")) return;
    listen((t) => { runCommand(t); }, fab, { quiet: true, onIdle: () => setTimeout(hfListen, 700) });
  }
  window.addEventListener("hg:spoken", () => { if (HF.on) setTimeout(hfListen, 500); });
  window.addEventListener("hg:speaking", () => { if (activeRec && HF.on) activeRec.abort(); });
  function setHandsfree(v) { HF.on = v; store.set("handsfree", v); fab.classList.toggle("hf", v); if (v) { speak("말로만 하기를 켰어요. 안내가 끝나면 제가 들을게요. 다 왔어요, 버스 언제 와, 도와줘, 처럼 말씀하세요.", { force: true }); } else if (activeRec) activeRec.abort(); }
  fab.classList.toggle("hf", HF.on);

  // ───────────────────────── 처음 화면 (한 번에 하나만 크게) ─────────────────────────
  function tripInProgress() {
    const t = store.get("trip", null);
    return t && (t === "outdoor" || t === "indoor") ? t : null;
  }
  function renderHome() {
    const now = new Date();
    setStep("오늘", now.toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "long" }));
    const trip = tripInProgress();
    const tripPlace = trip === "indoor" ? "병원 안 · 처음오신 창구" : (RT().outdoor[state.outIdx] || {}).place;
    const gN = G.list().length;
    main.innerHTML = `
      <section class="card hello">
        <p class="big">안녕하세요.<br>무엇을 도와드릴까요?</p>
      </section>
      <form id="homeSearch" class="search home-search" role="search">
        <input id="homeQ" type="search" enterkeyhint="search" placeholder="🔍 병원 이름으로 찾기" autocomplete="off">
        <button class="btn btn-primary" type="submit">찾기</button>
      </form>
      ${planBanner()}
      ${trip ? `<button class="card resume" id="resume">▶ <b>하던 길 안내 이어서</b><br><span class="muted">${esc(tripPlace || "")}</span></button>` : ""}
      <div class="tiles tiles-2">
        <button class="tile" data-go="near">🏥<span>병원 찾기·응급실</span></button>
        <button class="tile" data-go="plan">⏰<span>몇 시에 나갈까</span></button>
        <button class="tile" data-go="doctor">🩺<span>진료 메모</span></button>
        <button class="tile" data-go="guardian">👪<span>${gN ? `보호자 ${gN}명` : "보호자 등록"}</span></button>
      </div>
      <button class="btn btn-light more-btn" id="moreTools">☰ 다른 도움 더 보기 <small>택시 · 여기가 어디 · 외국어·필담</small></button>`;
    main.querySelectorAll("[data-go]").forEach(b => b.onclick = () => {
      const k = b.dataset.go;
      if (k === "near") openNear("hosp"); else if (k === "doctor") openDoctor(); else if (k === "guardian") openGuardian(); else openScreen(k);
    });
    const pb = $("#planBanner"); if (pb) pb.onclick = () => openScreen("plan");
    const rs = $("#resume"); if (rs) rs.onclick = () => go(trip);
    $("#moreTools").onclick = openMenu;
    $("#homeSearch").onsubmit = (e) => { e.preventDefault(); const q = $("#homeQ").value.trim(); if (q) openNear("hosp", deptQuery(q) || q); else openNear("hosp"); };
    const talkNow = btn("🎙 눌러서 말하기", "btn-xl btn-talk", () => listen(homeVoice, talkNow, { prompt: "무엇을 도와드릴까요?\n예) “분당서울대병원 가요” · “근처 약국” · “택시 불러 줘”" }));
    dock.replaceChildren(talkNow, btn("🚶 병원 가는 길 시작", "btn-light", () => startTalk()));
    speak(trip ? "안녕하세요. 하던 길 안내를 이어서 하시려면 초록 테두리 버튼을 누르세요." : "안녕하세요. 병원 한걸음이에요. 아래 노란 버튼을 누르고 편하게 말씀하세요.");
  }

  // ☰ 메뉴: 자주 안 쓰는 기능은 여기로 모음
  function openMenu() {
    const old = $("#menuSheet"); if (old) { old.remove(); return; }
    const wrap = document.createElement("div");
    wrap.id = "menuSheet"; wrap.className = "overlay sheet"; wrap.setAttribute("role", "dialog"); wrap.setAttribute("aria-modal", "true"); wrap.setAttribute("aria-label", "메뉴");
    wrap.innerHTML = `<div class="sheet-inner"><p class="big" style="font-size:24px">무엇이 필요하세요?</p><div class="tiles menu-tiles"></div></div>`;
    const items = [
      ["🏠", "처음 화면", () => go("home")],
      ["🚶", "병원 가는 길", () => tripInProgress() ? go(tripInProgress()) : startTalk()],
      ["🏥", "병원 찾기·응급실", () => openNear("hosp")],
      ["⏰", "몇 시에 나갈까", () => openScreen("plan")],
      ["🩺", "진료 메모", () => openDoctor()],
      ["👪", "보호자", () => openGuardian()],
      ["🚕", "택시 타기", () => openScreen("taxi")],
      ["📷", "여기가 어디?", () => openScreen("where")],
      ["🌐", "외국어·필담", () => openScreen("lang")],
      ["🔠", state.big ? "글씨 보통으로" : "글씨 더 크게", () => setBig(!state.big)],
      ["🎙", "마이크 시험·고치기", () => openScreen("mictest")],
      ["⚙︎", "설정 (목소리·권한)", () => openSettings()],
      ["✖", "닫기", () => {}]
    ];
    const box = wrap.querySelector(".menu-tiles");
    items.forEach(([ic, label, fn]) => {
      const b = document.createElement("button"); b.className = "tile"; b.innerHTML = `${ic}<span>${label}</span>`;
      b.onclick = () => { wrap.remove(); fn(); }; box.append(b);
    });
    wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
    document.body.append(wrap);
  }
  function setBig(v) { state.big = v; store.set("big", v); document.documentElement.classList.toggle("big-text", v); speak(v ? "글씨를 크게 했어요." : "글씨를 보통으로 했어요."); }
  state.big = store.get("big", false);
  document.documentElement.classList.toggle("big-text", state.big);

  // ───────────────────────── 마이크가 되게: 시험 · 다른 브라우저로 열기 ─────────────────────────
  const isSamsung = /SamsungBrowser/i.test(UA);
  const isKakao = /KAKAOTALK/i.test(UA);
  const isChromeAndroid = isAndroid && /Chrome\//.test(UA) && !isSamsung && !inApp && !/EdgA|OPR|Whale|NAVER/i.test(UA);
  const isSafariIOS = isIOS && /Safari\//.test(UA) && !/CriOS|FxiOS|EdgiOS|NAVER|KAKAOTALK|Whale/i.test(UA);
  // 말 알아듣기가 잘 되는 브라우저인지
  function micBrowserOK() { return !!SR && !inApp && !isSamsung; }
  // 지금 페이지를 Chrome(안드로이드) / 기본 브라우저(카카오톡)로 다시 열기
  function openInGoodBrowser() {
    const url = location.href;
    if (isKakao) { location.href = "kakaotalk://web/openExternal?url=" + encodeURIComponent(url); return; }
    if (isAndroid) {
      const u = new URL(url);
      location.href = `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`;
      return;
    }
    // 아이폰 앱 안 브라우저는 직접 열어야 함
    navigator.clipboard && navigator.clipboard.writeText(url).catch(() => {});
    alert("주소를 복사했어요.\n\n오른쪽 아래(또는 위) ⋯ 버튼 → ‘Safari로 열기’를 누르거나,\nSafari를 열고 주소창에 붙여 넣어 주세요.");
  }
  function browserAdvice() {
    if (isKakao) return { msg: "카카오톡 안에서 열려 있어요. 카카오톡 안에서는 마이크가 잘 안 돼요.", btn: "🌐 기본 브라우저로 열기" };
    if (inApp) return { msg: "다른 앱 안의 브라우저로 열려 있어요. 여기서는 마이크가 잘 안 돼요.", btn: isAndroid ? "🌐 Chrome으로 열기" : "🌐 Safari로 여는 방법" };
    if (isSamsung) return { msg: "삼성 인터넷은 ‘말 알아듣기’를 지원하지 않아요. Chrome으로 열면 돼요.", btn: "🌐 Chrome으로 열기" };
    if (!SR && isAndroid) return { msg: "이 브라우저는 ‘말 알아듣기’를 지원하지 않아요. Chrome으로 열어 주세요.", btn: "🌐 Chrome으로 열기" };
    if (!SR && isIOS) return { msg: "이 브라우저는 ‘말 알아듣기’를 지원하지 않아요. Safari로 열어 주세요.", btn: "🌐 Safari로 여는 방법" };
    if (!SR) return { msg: "이 브라우저는 ‘말 알아듣기’를 지원하지 않아요. Chrome으로 열어 주세요.", btn: null };
    return null;
  }
  function micDeniedGuide() {
    if (isIOS) return `① Safari 주소창 왼쪽 <b>‘가가’(aA)</b> → <b>웹 사이트 설정</b> → <b>마이크 ‘허용’</b><br>② 그래도 안 되면 아이폰 <b>설정 → 앱 → Safari → 마이크 → 허용</b><br>③ <b>설정 → 일반 → 키보드 → ‘받아쓰기 활성화’</b> 켜기 (말 알아듣기에 필요)<br>④ 이 화면으로 돌아와 <b>새로고침</b>`;
    if (isAndroid) return `① Chrome 주소창 왼쪽 <b>설정(⚙ 또는 자물쇠)</b> → <b>권한</b> → <b>마이크 ‘허용’</b><br>② 안 보이면 휴대폰 <b>설정 → 애플리케이션 → Chrome → 권한 → 마이크 → 허용</b><br>③ 이 화면으로 돌아와 <b>새로고침</b>`;
    return "주소창 왼쪽 자물쇠 버튼 → 마이크 ‘허용’ → 새로고침";
  }

  // 마이크 시험: ① 소리가 들어오는지(막대) ② 말을 글자로 바꾸는지
  const MT = { stream: null, ctx: null, raf: 0, peak: 0 };
  function micTestStop() {
    cancelAnimationFrame(MT.raf);
    if (MT.stream) MT.stream.getTracks().forEach(t => t.stop());
    if (MT.ctx) MT.ctx.close().catch(() => {});
    MT.stream = MT.ctx = null;
  }
  async function micLevelTest() {
    const out = $("#mtLevel"), bar = $("#mtBar");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !isSecureContext) { out.innerHTML = "❌ 이 브라우저는 마이크를 쓸 수 없어요."; return "unsupported"; }
    out.textContent = "휴대폰이 마이크를 물어보면 ‘허용’을 눌러 주세요…";
    const slow = setTimeout(() => {
      out.innerHTML = `⏳ 허용 창이 안 보이나요?<div class="sign" style="font-size:18px;margin-top:8px">화면 위·아래에 작은 창이 떠 있으면 <b>‘허용’</b>을 눌러 주세요.<br>아무것도 없으면:<br>${micDeniedGuide()}</div>`;
      speak("허용 창이 안 보이면, 화면의 방법대로 마이크를 허용해 주세요.", { force: true });
    }, 10000);
    try { MT.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); clearTimeout(slow); }
    catch (e) {
      clearTimeout(slow);
      const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
      perm.mic = denied ? "denied" : "error";
      out.innerHTML = denied ? `❌ 마이크가 막혀 있어요.<div class="sign" style="font-size:18px;margin-top:8px">${micDeniedGuide()}</div>`
        : e && e.name === "NotFoundError" ? "❌ 마이크를 찾지 못했어요." : e && e.name === "NotReadableError" ? "❌ 다른 앱(통화·녹음)이 마이크를 쓰고 있어요. 끄고 다시 해 보세요." : "❌ 마이크를 켜지 못했어요.";
      speak(denied ? "마이크가 막혀 있어요. 화면의 방법대로 허용해 주세요." : "마이크를 켜지 못했어요.", { force: true });
      return "denied";
    }
    perm.mic = "granted";
    const AC = window.AudioContext || window.webkitAudioContext;
    MT.ctx = new AC(); const src = MT.ctx.createMediaStreamSource(MT.stream), an = MT.ctx.createAnalyser();
    an.fftSize = 512; src.connect(an); const buf = new Uint8Array(an.fftSize); MT.peak = 0;
    out.textContent = "🎙 ‘아-’ 하고 소리를 내 보세요";
    const t0 = Date.now();
    await new Promise(res => {
      const loop = () => {
        an.getByteTimeDomainData(buf);
        let sum = 0; for (const v of buf) sum += ((v - 128) / 128) ** 2;
        const lvl = Math.min(1, Math.sqrt(sum / buf.length) * 6);
        MT.peak = Math.max(MT.peak, lvl);
        if (bar) bar.style.width = Math.round(lvl * 100) + "%";
        if (Date.now() - t0 > 4000) return res();
        MT.raf = requestAnimationFrame(loop);
      };
      loop();
    });
    micTestStop();
    const ok = MT.peak > 0.08;
    out.innerHTML = ok ? "✅ 마이크 소리가 잘 들어와요." : "⚠️ 소리가 거의 안 들어와요. 휴대폰 아래쪽 마이크 구멍을 막지 말고, 입 가까이에서 다시 해 보세요.";
    return ok ? "ok" : "quiet";
  }
  function renderMicTest() {
    setStep("🎙 마이크 시험", "말이 잘 들리는지 확인");
    const adv = browserAdvice();
    main.innerHTML = `
      ${adv ? `<section class="card warn-card"><p style="margin:0;font-size:20px">⚠️ ${esc(adv.msg)}</p>${adv.btn ? `<button class="btn btn-primary" id="mtOpen" style="margin-top:10px;width:100%">${adv.btn}</button>` : ""}</section>` : ""}
      <section class="card">
        <p class="sum-title" style="font-size:22px">① 마이크에 소리가 들어오나요?</p>
        <div class="meter"><div id="mtBar"></div></div>
        <p id="mtLevel" class="mt-msg">아래 ‘시험 시작’을 눌러 주세요.</p>
      </section>
      <section class="card">
        <p class="sum-title" style="font-size:22px">② 말을 글자로 알아듣나요?</p>
        <p id="mtSR" class="mt-msg">${SR ? "①이 끝나면 아무 말이나 해 보세요. 예) “안녕하세요”" : "❌ 이 브라우저는 말 알아듣기를 지원하지 않아요. 대신 키보드의 🎤 받아쓰기로 쓸 수 있어요."}</p>
      </section>
      <p class="muted" style="font-size:16px">🔒 시험할 때 소리는 녹음하거나 저장하지 않아요.</p>`;
    const ob = $("#mtOpen"); if (ob) ob.onclick = openInGoodBrowser;
    const start = btn("▶ 시험 시작", "btn-xl btn-talk", async () => {
      start.disabled = true;
      const r1 = await micLevelTest();
      if (r1 === "ok" || r1 === "quiet") {
        if (!SR) { start.disabled = false; return speak("마이크는 되지만, 이 브라우저는 말 알아듣기를 지원하지 않아요.", { force: true }); }
        $("#mtSR").textContent = "🎙 지금 ‘안녕하세요’라고 말해 보세요";
        speakThenListen();
      } else start.disabled = false;
    });
    // 말 알아듣기는 화면을 누른 순간 시작해야 하는 휴대폰이 있어서, 버튼을 하나 더 둠
    const srBtn = btn("🗣 ②만 다시 해 보기", "btn-light", function () { trySR(this); });
    function speakThenListen() {
      start.disabled = false;
      $("#mtSR").innerHTML = "아래 <b>‘②만 다시 해 보기’</b>를 누르고 ‘안녕하세요’라고 말해 보세요.";
      speak("이제 아래 버튼을 누르고, 안녕하세요, 라고 말해 보세요.", { force: true });
    }
    function trySR(b) {
      const box = $("#mtSR");
      listen(t => {
        box.innerHTML = `✅ 알아들었어요: <b>“${esc(t)}”</b><br>마이크가 잘 돼요!`;
        speak("잘 알아들었어요. 마이크가 잘 돼요.", { force: true });
        perm.mic = "granted";
      }, b, { quiet: true, onIdle: () => { box.innerHTML = "⚠️ 말을 못 들었어요. 버튼을 누르고 바로 또박또박 말해 보세요."; } });
    }
    dock.replaceChildren(start, row(srBtn, backBtnTo("mictest")));
    speak("마이크가 잘 되는지 시험해 볼게요. 노란 시험 시작 버튼을 눌러 주세요.");
  }

  // ───────────────────────── 렌더 ─────────────────────────
  function render() {
    document.body.classList.toggle("reduce", state.reduce);
    if (state.screen === "outdoor" || state.screen === "indoor") store.set("trip", state.screen);
    if (state.screen === "done") store.set("trip", null);
    const ms = $("#menuSheet"); if (ms) ms.remove();
    // 큰 "누르고 말하기" 버튼이 이미 있는 화면에서는 떠 있는 마이크를 숨김
    const f = $("#fab"); if (f) f.hidden = ["home", "talk", "perm", "mictest", "near"].includes(state.screen) && !(typeof HF !== "undefined" && HF.on);
    if (maps.pick) { maps.pick.remove(); maps.pick = null; }
    if (maps.mini) { maps.mini.remove(); maps.mini = null; }
    if (maps.near) { maps.near.remove(); maps.near = null; }
    ({ mictest: renderMicTest, home: renderHome, lang: renderLang, taxi: renderTaxi, plan: renderPlan, where: renderWhere, guardian: renderGuardian, near: renderNear, doctor: renderDoctor, perm: renderPerm, pick: renderPick, talk: renderTalk, confirm: renderConfirm, apply: renderApply, outdoor: renderOutdoor, indoor: renderIndoor, done: renderDone }[state.screen] || renderHome)();
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function resetAll() {
    stopSpeaking(); stopNav(); store.clear(); notified.clear();
    Object.assign(state, { screen: "home", slots: { hospital: null, firstVisit: null, mobility: null, reception: null }, heard: "", outIdx: 0, inIdx: 0, dest: null });
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
  $("#btnMenu").onclick = openMenu;
  function openSettings() {
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
  $("#guardianBtn").onclick = openGuardian;
  $("#hfToggle").checked = HF.on;
  $("#hfToggle").onchange = (e) => setHandsfree(e.target.checked);
  $("#helpWhere").onclick = () => openScreen("where");
  $("#helpLang").onclick = () => openScreen("lang");
  $("#sosGuardian").onclick = () => { $("#sos").hidden = true; notifyGuardians("help", "도움이 필요해요! 119에 전화하려고 해요. 연락 주세요.", { force: true, urgent: true }); };
  $("#helpGuardian").onclick = () => { $("#helpCard").hidden = true; notifyGuardians("help", `길을 잃었어요. ${state.screen === "indoor" ? "분당서울대병원 1동 안이에요." : ""} 연락 주세요.`, { force: true, urgent: true }); };
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
