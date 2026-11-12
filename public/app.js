// Alibi AI frontend. Plain JavaScript, no build step.
// Security note: every string from the server or from players is passed through esc() before it is placed in HTML.

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const WITNESSES = [
  { id: "jules", name: "Jules Hart", title: "Security officer" },
  { id: "ivo", name: "Ivo Bell", title: "Maintenance engineer" },
];
const ROLE_TITLES = { systems: "Systems analyst", records: "Records specialist", field: "Field investigator" };
const MODE_LABEL = {
  scripted: ["SCRIPTED", "amber"],
  "live-ai": ["LIVE AI", "green"],
};

let token = sessionStorage.getItem("alibi_token");
let config = { liveAi: false, witnessMode: "scripted", paypal: null };
let state = null;
let lastJson = "";
let tab = "file";
let witnessSel = "ivo";
let pending = null;        // { witnessId, question } while waiting for a witness
let archiveBusy = false;
let archiveResult = null;
let payMsg = "";
let flash = "";            // message to show on the home screen

// ---------- helpers ----------
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error("Network problem. Check your connection and try again."), { status: 0 });
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

let toastTimer;
function toast(msg, kind = "error") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (kind === "info" ? " info" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 5000);
}

function setToken(t) {
  token = t;
  if (t) sessionStorage.setItem("alibi_token", t); else sessionStorage.removeItem("alibi_token");
}

function leave(message = "") {
  setToken(null); state = null; lastJson = ""; archiveResult = null; tab = "file"; flash = message;
  history.replaceState(null, "", "/");
  render();
}

function setState(s) {
  state = s;
  lastJson = JSON.stringify(s);
  render();
}

async function refresh() {
  if (!token) return;
  try {
    const s = await api("GET", "/api/state");
    const j = JSON.stringify(s);
    if (j !== lastJson) { lastJson = j; state = s; render(); }
  } catch (e) {
    if (e.status === 401) leave("Your session expired or the room no longer exists.");
  }
}

// Keep typed text and focus when the screen re-renders (e.g. a teammate shares a clue).
function captureInputs() {
  const saved = { fields: {}, focus: null };
  document.querySelectorAll("#app input[id], #app textarea[id]").forEach((el) => {
    saved.fields[el.id] = el.type === "checkbox" || el.type === "radio" ? el.checked : el.value;
  });
  const a = document.activeElement;
  if (a && a.id && saved.fields[a.id] !== undefined) {
    saved.focus = { id: a.id, start: a.selectionStart, end: a.selectionEnd };
  }
  return saved;
}
function restoreInputs(saved) {
  for (const [id, v] of Object.entries(saved.fields)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === "checkbox" || el.type === "radio") el.checked = v; else el.value = v;
  }
  if (saved.focus) {
    const el = document.getElementById(saved.focus.id);
    if (el) { el.focus(); try { el.setSelectionRange(saved.focus.start, saved.focus.end); } catch {} }
  }
}

// ---------- views ----------
function clueCard(c, { share = false, sharedBy = null, alreadyShared = false } = {}) {
  return `<article class="clue">
    <div class="meta"><span class="chip">${esc(c.id)}</span><span class="small muted">${esc(c.sourceType)} · ${esc(c.timestamp)}</span>
      ${sharedBy ? `<span class="badge blue">Shared by ${esc(sharedBy)}</span>` : ""}
      ${alreadyShared ? `<span class="badge green">Shared with group</span>` : ""}</div>
    <h3>${esc(c.title)}</h3>
    <p>${esc(c.text)}</p>
    ${share && !alreadyShared ? `<button data-action="share" data-id="${esc(c.id)}">Share with the group</button>` : ""}
  </article>`;
}

function homeView() {
  const join = new URLSearchParams(location.search).get("join") || "";
  const payOk = !!config.paypal;
  return `
  <section class="hero">
    <h1>A mystery night with AI witnesses and secrets only your friends know.</h1>
    <p class="lead">At 21:12 the lights go out at Blackridge Research Station. When they come back, the Aster, a valuable mineral scanner, is gone. Three people had access. Each has an alibi. Each of you holds different evidence. Question the witnesses, decide what to share, and work out what really happened.</p>
    <p class="muted small">3 players · 20–30 minutes · works on phones</p>
  </section>
  ${flash ? `<div class="banner bad">${esc(flash)}</div>` : ""}
  <div class="grid">
    <form class="card stack" data-form="host">
      <h2>Host a game</h2>
      <p class="muted small">Purchase the adventure once (PayPal <strong>sandbox</strong>, test money only) and invite two friends with a room code.</p>
      ${payOk ? "" : `<p class="small" style="color:var(--amber)">PayPal sandbox keys are not configured on this server, so purchasing is unavailable. Use solo mode below.</p>`}
      <label for="host-name">Your name</label>
      <input id="host-name" type="text" maxlength="30" autocomplete="nickname" required>
      <button class="primary" type="submit" ${payOk ? "" : "disabled"}>Create room</button>
    </form>
    <form class="card stack" data-form="join">
      <h2>Join with a code</h2>
      <p class="muted small">Your host buys the adventure; you don't pay.</p>
      <label for="join-code">Room code</label>
      <input id="join-code" type="text" maxlength="8" autocapitalize="characters" autocomplete="off" value="${esc(join)}" required>
      <label for="join-name">Your name</label>
      <input id="join-name" type="text" maxlength="30" autocomplete="nickname" required>
      <button class="primary" type="submit">Join</button>
    </form>
    <form class="card stack" data-form="solo">
      <h2>Solo demonstration <span class="badge amber">Free</span></h2>
      <p class="muted small">One person sees <strong>all three</strong> investigators' files, so you can test the whole case. This is a demo mode, separate from a purchased multiplayer session.</p>
      <label for="solo-name">Your name</label>
      <input id="solo-name" type="text" maxlength="30" autocomplete="nickname" required>
      <button type="submit">Start solo demo</button>
    </form>
  </div>`;
}

function lobbyView() {
  const s = state, host = s.me.isHost, paid = s.room.purchaseStatus === "paid";
  const canStart = host && paid && s.members.length >= 2;
  const link = `${location.origin}/?join=${s.room.code}`;
  let pay = "";
  if (paid) {
    pay = `<div class="banner ok"><strong>Adventure purchased</strong> (PayPal sandbox, test funds). Guests don't pay separately.</div>`;
  } else if (host) {
    pay = `<div class="pay-box stack">
      <h3>Purchase the adventure <span class="badge blue">Sandbox</span></h3>
      <p class="small muted">Price: <strong>${esc(config.paypal?.currency)} ${esc(config.paypal?.amount)}</strong> (illustrative test price). This uses PayPal's sandbox with <strong>test funds only</strong>. Log in with your sandbox <em>Personal</em> test account. No real money moves. Access unlocks only after the server verifies the payment with PayPal.</p>
      <div id="pay-placeholder"></div>
      <p id="pay-msg" class="small" role="status">${esc(payMsg)}</p>
    </div>`;
  } else {
    pay = `<div class="banner solo">Waiting for the host to purchase the adventure.</div>`;
  }
  return `
  <div class="grid">
    <section class="card">
      <p class="muted small">Room code</p>
      <div class="code" aria-label="Room code ${esc(s.room.code.split("").join(" "))}">${esc(s.room.code)}</div>
      <p class="small muted" style="margin-top:8px">Friends can join at <strong>${esc(location.origin)}</strong> with this code, or use this link:</p>
      <div class="row"><input type="text" readonly value="${esc(link)}" id="invite-link" aria-label="Invite link"><button data-action="copy-link">Copy</button></div>
    </section>
    <section class="card">
      <h2>Investigators (${s.members.length}/${s.room.maxPlayers})</h2>
      <ul class="members">${s.members.map((m) => `<li><span>${esc(m.name)}${m.isYou ? " (you)" : ""}${m.isHost ? ' <span class="badge amber">Host</span>' : ""}</span><span class="muted">${esc(m.roleTitle)}</span></li>`).join("")}</ul>
      <p class="small muted">Your role: <strong>${esc(s.me.roleTitle)}</strong>. ${esc(s.me.intro)} Your private files unlock when the investigation starts.</p>
    </section>
  </div>
  <section class="card stack">
    ${pay}
    ${host
      ? `<button class="primary" data-action="start" ${canStart ? "" : "disabled"}>Start investigation</button>
         <p class="small muted">${paid ? (s.members.length < 2 ? "At least 2 players are needed (3 recommended)." : "Everyone who has joined will be locked in.") : "Purchase the adventure first."}</p>`
      : `<p class="muted">The host will start the investigation. This page updates automatically.</p>`}
  </section>`;
}

function availableClues(s) {
  const map = new Map();
  [...s.privateClues, ...s.sharedClues].forEach((c) => map.set(c.id, c));
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function investigationView() {
  const s = state;
  const tabs = [
    ["file", "My file", s.privateClues.length],
    ["witnesses", "Witnesses", null],
    ["board", "Evidence board", s.sharedClues.length],
    ["archive", "Archive", null],
    ["accuse", "Accuse", null],
  ];
  const banner = s.room.mode === "solo"
    ? `<div class="banner solo"><strong>SOLO DEMONSTRATION MODE:</strong> you can see all three investigators' files. In a real game each player sees only their own two clues.</div>` : "";
  return `${banner}
  <nav class="tabs" role="tablist" aria-label="Investigation sections">
    ${tabs.map(([id, label, n]) => `<button class="tab" role="tab" aria-selected="${tab === id}" data-action="tab" data-tab="${id}">${label}${n != null ? `<span class="count">${n}</span>` : ""}</button>`).join("")}
  </nav>
  ${tab === "file" ? fileTab() : tab === "witnesses" ? witnessTab() : tab === "board" ? boardTab() : tab === "archive" ? archiveTab() : accuseTab()}`;
}

function fileTab() {
  const s = state;
  return `<section class="card"><h2>${s.room.mode === "solo" ? "All investigator files" : `Your file: ${esc(s.me.roleTitle)}`}</h2>
    <p class="muted">${s.room.mode === "solo" ? "Every clue in the case." : esc(s.me.intro) + " Only you can see these clues until you share them."}</p></section>
    ${s.privateClues.map((c) => clueCard(c, { share: true, alreadyShared: c.shared })).join("")}`;
}

function boardTab() {
  const s = state;
  return `<section class="card"><h2>Evidence board</h2><p class="muted">Clues anyone has shared with the group.</p></section>
  ${s.sharedClues.length ? s.sharedClues.map((c) => clueCard(c, { sharedBy: c.sharedBy })).join("")
    : `<div class="card muted">Nothing shared yet. Share a clue from your file, or ask a teammate to share theirs.</div>`}`;
}

function badge(mode) {
  const [label, color] = MODE_LABEL[mode] || [String(mode).toUpperCase(), ""];
  return `<span class="badge ${color}">${esc(label)}</span>`;
}

function witnessTab() {
  const s = state;
  const w = WITNESSES.find((x) => x.id === witnessSel);
  const history = s.messages.filter((m) => m.witnessId === witnessSel);
  return `<section class="card">
    <h2>Interview a witness</h2>
    <p class="muted small">Ask anything in your own words. Witnesses only know what they saw. They'll tell you when they don't know, and AI witnesses can still make mistakes. Your conversations are private to you.</p>
    <div class="witness-pick">${WITNESSES.map((x) => `<button data-action="pick-witness" data-id="${x.id}" aria-pressed="${x.id === witnessSel}">${esc(x.name)}<br><span class="small muted">${esc(x.title)}</span></button>`).join("")}</div>
    <div class="chat">
      ${history.length || (pending && pending.witnessId === witnessSel) ? "" : `<p class="muted">Ask ${esc(w.name)} something, for example: <em>${w.id === "ivo" ? "“Could someone operate F2 from the west gantry?”" : "“Did you see anyone near the freight dock?”"}</em></p>`}
      ${history.map((m) => `<div class="msg q">${esc(m.question)}</div>
        <div class="msg a"><div class="who"><strong>${esc(w.name)}</strong>${badge(m.responseMode)}</div>${esc(m.answer)}</div>`).join("")}
      ${pending && pending.witnessId === witnessSel ? `<div class="msg q">${esc(pending.question)}</div><div class="msg a muted"><span class="spinner"></span> ${esc(w.name)} is thinking…</div>` : ""}
    </div>
    <form data-form="witness" class="stack">
      <label for="wq">Your question (max 300 characters)</label>
      <textarea id="wq" maxlength="300" ${pending ? "disabled" : ""}></textarea>
      <div class="row">
        <button class="primary" type="submit" ${pending ? "disabled" : ""}>Ask ${esc(w.name.split(" ")[0])}</button>
        ${config.liveAi ? `<label class="row small" style="margin:0"><input type="checkbox" id="wscripted"> Use scripted answers</label>` : `<span class="badge amber">Scripted mode: no AI key configured</span>`}
      </div>
    </form>
  </section>`;
}

function archiveTab() {
  const r = archiveResult;
  return `<section class="card stack">
    <h2>Evidence archive</h2>
    <p class="muted small">Ask about evidence <strong>you</strong> can see (your own file plus shared clues). The archive searches by keyword. It is not semantic search, and it never touches other players' unshared clues.</p>
    <form data-form="archive" class="stack">
      <label for="aq">Question</label>
      <textarea id="aq" maxlength="300" style="min-height:70px" ${archiveBusy ? "disabled" : ""}></textarea>
      <button class="primary" type="submit" ${archiveBusy ? "disabled" : ""}>${archiveBusy ? '<span class="spinner"></span> Searching…' : "Search evidence"}</button>
    </form>
  </section>
  ${r ? `<section class="card">
      <div class="row"><h3 style="margin:0">Result</h3><span class="badge ${r.mode.startsWith("live") ? "green" : "amber"}">${r.mode.startsWith("live") ? "AI summary + keyword retrieval" : "Keyword retrieval"}</span></div>
      <p style="margin-top:10px">${esc(r.answer)}</p>
      ${r.sourceIds.length ? `<p class="small muted">Sources: ${r.sourceIds.map((id) => `<button class="chip" data-action="open-clue" data-id="${esc(id)}">${esc(id)}</button>`).join(" ")}</p>` : ""}
      ${r.passages.map((p) => `<div class="clue"><div class="meta"><span class="chip">${esc(p.clueId)}</span><span class="small muted">${esc(p.sourceType)} · ${esc(p.timestamp)}</span></div><strong>${esc(p.title)}</strong><p class="small" style="margin:4px 0 0">${esc(p.text)}</p></div>`).join("")}
    </section>` : ""}`;
}

function accuseTab() {
  const s = state;
  if (!s.me.isHost) {
    return `<section class="card"><h2>Accusation</h2><p>Only the host submits the group's final accusation. Discuss your theory with the group (on a voice call, say) and make sure the host cites the right clues.</p></section>`;
  }
  const clues = availableClues(s);
  return `<form class="card stack" data-form="accuse">
    <h2>Final accusation</h2>
    <p class="muted small">This is final. Choose the suspect, explain the reasoning, and cite the clues that support it. Strong evidence ties someone to the act. Alibi checks and badge scans alone are weaker.</p>
    <fieldset style="border:none;padding:0;margin:0"><legend class="small muted" style="margin-bottom:6px">Who did it?</legend>
      ${s.suspects.map((p) => `<label class="suspect" for="sus-${esc(p.id)}"><input type="radio" name="suspect" id="sus-${esc(p.id)}" value="${esc(p.id)}"><span><strong>${esc(p.name)}</strong> · ${esc(p.position)}<br><span class="small muted">Claims: ${esc(p.alibi)}</span></span></label>`).join("")}
    </fieldset>
    <label for="why">Why? (explain the group's reasoning)</label>
    <textarea id="why" maxlength="1500"></textarea>
    <fieldset style="border:none;padding:0;margin:0"><legend class="small muted" style="margin-bottom:6px">Supporting clues available to the group</legend>
      ${clues.map((c) => `<label class="clue-pick" for="cl-${esc(c.id)}"><input type="checkbox" name="clue" id="cl-${esc(c.id)}" value="${esc(c.id)}"><span><span class="chip">${esc(c.id)}</span> <strong>${esc(c.title)}</strong>${c.sharedBy ? ` <span class="small muted">(shared by ${esc(c.sharedBy)})</span>` : ""}</span></label>`).join("")}
    </fieldset>
    <label class="row" style="color:var(--text)" for="confirm"><input type="checkbox" id="confirm"> I confirm this is the group's final decision.</label>
    <button class="primary" type="submit">Submit accusation</button>
  </form>`;
}

function revealView() {
  const s = state, r = s.reveal;
  const nameOf = (id) => s.suspects.find((x) => x.id === id)?.name || id;
  const col = { strong: "green", supporting: "blue", exonerating: "blue", weak: "amber" };
  return `
  <div class="banner ${r.accusation.correct ? "ok" : "bad"}">
    <h2>${r.accusation.correct ? "Case solved." : "Not quite."}</h2>
    <p>You accused <strong>${esc(nameOf(r.accusation.suspect))}</strong>. The person responsible was <strong>${esc(nameOf(r.culprit))}</strong>.</p>
    <p class="small muted" style="margin:0">Your reasoning: “${esc(r.accusation.explanation)}” · Clues cited: ${r.accusation.clueIds.map((i) => `<span class="chip">${esc(i)}</span>`).join(" ")}</p>
  </div>
  <section class="card"><h2>What happened</h2><p>${esc(r.summary)}</p>
    <ul class="timeline">${r.timeline.map((t) => `<li><span class="t">${esc(t.time)}</span><br>${esc(t.event)} ${t.clueIds.map((i) => `<span class="chip">${esc(i)}</span>`).join(" ")}</li>`).join("")}</ul>
  </section>
  <section class="card"><h2>How strong was the evidence?</h2>
    <table><thead><tr><th>Clue</th><th>Strength</th><th>Why</th></tr></thead><tbody>
    ${r.evidenceStrength.map((e) => `<tr><td><span class="chip">${esc(e.clueId)}</span> ${esc(e.title)}</td><td><span class="badge ${col[e.strength] || ""}">${esc(e.strength)}</span></td><td>${esc(e.note)}</td></tr>`).join("")}
    </tbody></table>
    <p style="margin-top:12px">${esc(r.weakEvidenceNote)}</p>
  </section>
  <button class="primary" data-action="leave">Play again</button>`;
}

function view() {
  if (!token) return homeView();
  if (!state) return `<p class="muted"><span class="spinner"></span> Loading your case…</p>`;
  if (state.room.phase === "lobby") return lobbyView();
  if (state.room.phase === "investigation") return investigationView();
  return revealView();
}

function renderBadges() {
  const b = [];
  const [wl, wc] = MODE_LABEL[config.witnessMode] || MODE_LABEL.scripted;
  b.push(`<span class="badge ${wc}" title="How witnesses answer">Witnesses: ${wl}</span>`);
  if (state) {
    if (state.room.mode === "solo") b.push(`<span class="badge amber">Solo demo</span>`);
    else b.push(`<span class="badge blue">Sandbox · test funds</span>`);
    b.push(`<span class="badge">Room ${esc(state.room.code)}</span>`);
    b.push(`<button class="link small" data-action="leave" title="Leave this game on this device">Leave</button>`);
  }
  $("#badges").innerHTML = b.join("");
}

function render() {
  const saved = captureInputs();
  $("#app").innerHTML = view();
  restoreInputs(saved);
  renderBadges();
  const ph = $("#pay-placeholder");
  if (ph) { ph.replaceWith(paySlot); mountPayPal(); }
}

// ---------- PayPal (sandbox) ----------
// The button container lives outside the re-rendered area so a teammate joining doesn't destroy an open PayPal flow.
const paySlot = document.createElement("div");
paySlot.id = "paypal-buttons";
let payMounted = false;
let sdkPromise = null;

function loadSdk(cfg) {
  if (window.paypal) return Promise.resolve();
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(cfg.clientId)}&currency=${encodeURIComponent(cfg.currency)}&intent=capture`;
      s.onload = resolve;
      s.onerror = () => { sdkPromise = null; reject(new Error("Could not load PayPal.")); };
      document.head.appendChild(s);
    });
  }
  return sdkPromise;
}

function setPayMsg(msg) {
  payMsg = msg;
  const el = $("#pay-msg");
  if (el) el.textContent = msg;
}

async function mountPayPal() {
  if (payMounted || !config.paypal) return;
  payMounted = true;
  try {
    await loadSdk(config.paypal);
    await window.paypal.Buttons({
      style: { layout: "vertical", shape: "rect" },
      createOrder: async () => (await api("POST", "/api/paypal/create-order")).orderId,
      onApprove: async (data) => {
        setPayMsg("Verifying your payment with PayPal…");
        try {
          const r = await api("POST", "/api/paypal/capture-order", { orderId: data.orderID });
          if (r.status === "paid") { setPayMsg(""); toast("Payment verified (sandbox).", "info"); await refresh(); }
          else if (r.status === "pending") setPayMsg("Your payment is pending. The adventure stays locked until PayPal confirms it.");
          else setPayMsg("The payment was not completed. The adventure is still unpaid.");
        } catch (e) { setPayMsg(""); toast(e.message); }
      },
      onCancel: () => setPayMsg("Payment cancelled. You have not been charged, and the adventure is still unpaid."),
      onError: () => setPayMsg("PayPal reported a problem. Nothing was unlocked. Please try again."),
    }).render(paySlot);
  } catch (e) {
    payMounted = false;
    setPayMsg(e.message + " Check your connection and reload.");
  }
}

// ---------- actions ----------
async function enterRoom(path, body, { autoStart = false } = {}) {
  const r = await api("POST", path, body);
  setToken(r.token);
  history.replaceState(null, "", "/");
  flash = "";
  if (autoStart) { setState(await api("POST", "/api/start")); } else { await refresh(); }
}

document.addEventListener("submit", async (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  try {
    if (kind === "host") await enterRoom("/api/rooms", { name: $("#host-name").value, mode: "multiplayer" });
    else if (kind === "solo") await enterRoom("/api/rooms", { name: $("#solo-name").value, mode: "solo" }, { autoStart: true });
    else if (kind === "join") await enterRoom("/api/rooms/join", { code: $("#join-code").value, name: $("#join-name").value });
    else if (kind === "witness") await askWitness();
    else if (kind === "archive") await askArchive();
    else if (kind === "accuse") await submitAccusation();
  } catch (err) {
    toast(err.message);
    if (kind === "witness") { pending = null; render(); }
  }
});

async function askWitness() {
  const question = $("#wq").value.trim();
  if (!question) { toast("Type a question first."); return; }
  pending = { witnessId: witnessSel, question };
  render();
  try {
    await api("POST", "/api/witness", { witnessId: witnessSel, question, scripted: !!$("#wscripted")?.checked });
    $("#wq").value = "";
  } finally {
    pending = null;
    lastJson = "";
    await refresh();
  }
}

async function askArchive() {
  const question = $("#aq").value.trim();
  if (!question) { toast("Type a question first."); return; }
  archiveBusy = true; render();
  try {
    archiveResult = await api("POST", "/api/archive", { question });
  } finally {
    archiveBusy = false; render();
  }
}

async function submitAccusation() {
  const suspect = document.querySelector('input[name="suspect"]:checked')?.value;
  const explanation = $("#why").value.trim();
  const clueIds = [...document.querySelectorAll('input[name="clue"]:checked')].map((x) => x.value);
  if (!suspect) return toast("Choose a suspect.");
  if (explanation.length < 10) return toast("Explain the group's reasoning (at least 10 characters).");
  if (!clueIds.length) return toast("Select at least one supporting clue.");
  if (!$("#confirm").checked) return toast("Tick the box to confirm the final decision.");
  setState(await api("POST", "/api/accuse", { suspect, explanation, clueIds }));
  window.scrollTo({ top: 0 });
}

function openClue(id) {
  const c = [...(state?.privateClues || []), ...(state?.sharedClues || [])].find((x) => x.id === id)
    || archiveResult?.passages.map((p) => ({ id: p.clueId, title: p.title, sourceType: p.sourceType, timestamp: p.timestamp, text: p.text })).find((x) => x.id === id);
  if (!c) return;
  const m = $("#modal");
  m.innerHTML = `<div class="box" role="dialog" aria-modal="true" aria-label="Evidence ${esc(c.id)}">${clueCard(c)}<button data-action="close-modal">Close</button></div>`;
  m.hidden = false;
  m.querySelector("button").focus();
}

document.addEventListener("click", async (e) => {
  if (e.target.id === "modal") { $("#modal").hidden = true; return; }
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const a = el.dataset.action;
  try {
    if (a === "tab") { tab = el.dataset.tab; render(); }
    else if (a === "pick-witness") { witnessSel = el.dataset.id; render(); }
    else if (a === "start") setState(await api("POST", "/api/start"));
    else if (a === "share") { setState(await api("POST", "/api/share", { clueId: el.dataset.id })); toast("Clue shared with the group.", "info"); }
    else if (a === "open-clue") openClue(el.dataset.id);
    else if (a === "close-modal") $("#modal").hidden = true;
    else if (a === "leave") { if (confirm("Leave this game on this device? You can rejoin only while this browser tab keeps its session.")) leave(); }
    else if (a === "copy-link") {
      const v = $("#invite-link").value;
      try { await navigator.clipboard.writeText(v); toast("Invite link copied.", "info"); }
      catch { $("#invite-link").select(); toast("Press Ctrl/Cmd+C to copy."); }
    }
  } catch (err) {
    toast(err.message);
    if (err.status === 401) leave("Your session expired or the room no longer exists.");
  }
});

document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#modal").hidden = true; });

// ---------- boot ----------
setInterval(() => { if (!document.hidden && token && state && state.room.phase !== "reveal" && !pending) refresh(); }, 3000);

(async function boot() {
  try { config = await api("GET", "/api/config"); } catch { toast("Could not reach the server."); }
  if (token) { await refresh(); if (!state) { render(); } } else render();
})();
