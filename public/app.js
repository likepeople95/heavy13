// 무거운 13 — 화면
const COLORS = ["red", "green", "blue"];
const KO = { red: "빨강", green: "초록", blue: "파랑", rainbow: "레인보우" };
const LIMIT = 13;

const app = document.getElementById("app");
const toastBox = document.getElementById("toast");
const rulesDialog = document.getElementById("rules");

const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 저장 불가 환경 */ } },
};

const cleanCode = (x) => String(x || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const S = {
  code: cleanCode(new URLSearchParams(location.search).get("room")) || null,
  token: null,
  view: null,
  offset: 0,
  sel: { card: null, chip: null },
  selRound: null,
  setup: false,
  netError: false,
  busy: false,
  lastBeat: 0,
  pollTimer: null,
  renderKey: "",
  screen: null,
  showHistory: false,
  seen: null, // 마지막으로 본 놓기 수 (연출 감지용)
  fx: { bust: {}, drop: null }, // bust[color] = {text, at}, drop = {stand, at}
};
if (S.code && S.code.length === 4) S.token = LS.get(`h13:t:${S.code}`);
else S.code = null;

const serverNow = () => Date.now() + S.offset;

/* ---------- 통신 ---------- */
async function api(method, payload) {
  let res;
  if (method === "GET") res = await fetch(`/api/room?${new URLSearchParams(payload)}`, { cache: "no-store" });
  else res = await fetch("/api/room", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  let json = null;
  try { json = await res.json(); } catch { /* 빈 응답 */ }
  if (!res.ok) {
    const e = new Error(json?.error || `요청에 실패했어요 (${res.status})`);
    e.status = res.status;
    e.setup = Boolean(json?.setup);
    throw e;
  }
  return json;
}

function pollDelay() {
  const v = S.view;
  if (document.hidden) return 5000;
  if (!v || v.status === "lobby") return 2000;
  if (v.status === "ended") return 4000;
  const st = v.game?.stage;
  if (st === "submit") return 1500;
  if (st === "roundEnd") return 1200;
  return 900;
}

async function poll() {
  clearTimeout(S.pollTimer);
  if (!S.code) return;
  try {
    const p = { code: S.code, token: S.token || "" };
    if (S.view?.me && Date.now() - S.lastBeat > 5000) {
      p.beat = S.view.me.id;
      S.lastBeat = Date.now();
    }
    accept(await api("GET", p));
    S.netError = false;
  } catch (e) {
    if (e.setup) { S.setup = true; render(); }
    else if (e.status === 404) { leaveRoom("방이 없어졌어요. 새로 만들어 주세요"); return; }
    else { S.netError = true; render(); }
  }
  S.pollTimer = setTimeout(poll, pollDelay());
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });

function accept(view) {
  if (!view) return;
  S.offset = view.serverNow - Date.now();
  S.setup = false;
  if (S.token && !view.me) { LS.del(`h13:t:${S.code}`); S.token = null; }
  detectFx(view);
  const g = view.game;
  if (g && S.selRound !== `${g.gameNo}-${g.round}`) {
    S.sel = { card: null, chip: null };
    S.selRound = `${g.gameNo}-${g.round}`;
  }
  S.view = view;
  render();
}

/** 새로 놓인 바위·벌점을 찾아 짧은 연출을 건다 */
function detectFx(view) {
  const g = view.game;
  if (!g) { S.seen = null; return; }
  const key = `${g.gameNo}-${g.round}`;
  const n = g.placements.length;
  if (!S.seen || S.seen.key !== key) {
    S.seen = { key, n: S.seen ? 0 : n }; // 처음 들어왔을 때는 지난 것을 연출하지 않음
  }
  if (n > S.seen.n) {
    const now = Date.now();
    for (const pl of g.placements.slice(S.seen.n)) {
      S.fx.drop = { stand: pl.stand, at: now, key: `${key}-${g.placements.indexOf(pl)}` };
      if (pl.cleared > 0) {
        const name = g.seats[pl.p]?.name || "";
        S.fx.bust[pl.stand] = { text: `${name} 벌점 +${pl.cleared}`, at: now };
      }
    }
    S.seen.n = n;
    setTimeout(() => render(), 1900);
  }
}

/* ---------- 공통 조각 ---------- */
function toast(msg) {
  const d = document.createElement("div");
  d.textContent = msg;
  toastBox.appendChild(d);
  setTimeout(() => d.remove(), 3200);
}

function tally(points) {
  if (points <= 0 || points > 25) return "";
  const strokes = ["M3 3H17", "M10 3V17", "M10 10H15", "M5 10V17", "M2 17H18"];
  let out = "";
  for (let left = points; left > 0; left -= 5) {
    const k = Math.min(5, left);
    out += `<svg viewBox="0 0 20 20" aria-hidden="true">${strokes.slice(0, k).map((d) => `<path d="${d}" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`).join("")}</svg>`;
  }
  return `<span class="tally" title="벌점 ${points}">${out}</span>`;
}

const chipDot = (chip) => `<i class="chip-dot c-${chip}" title="${KO[chip]}" aria-label="${KO[chip]} 칩"></i>`;
const cardFace = (n) => (n === null || n === undefined ? `<span class="card-face back" aria-label="뒤집힌 카드">?</span>` : `<span class="card-face">${n}</span>`);
const swatch = (color) => `<i class="swatch" style="background:var(--p${color})"></i>`;
const standSum = (rocks) => rocks.reduce((s, r) => s + r.w, 0);

function timerBar(until, totalMs) {
  if (!until) return "";
  return `<div class="timer" data-until="${until}" data-total="${totalMs}"><i></i></div>`;
}
const secsSpan = (until) => (until ? `<span class="secs" data-secs="${until}"></span>` : "");

/** 지금 차례가 사람이 골라야 하는 차례인지 (아니면 잠깐 보여 주고 자동으로 놓임) */
function turnNeedsHuman(g) {
  if (g.stage !== "placing" || g.turn === null) return false;
  const fromQueue = g.queue.length > 0;
  return (fromQueue && g.queue.length > 1) || g.picks[g.turn]?.chip === "rainbow";
}

function stageTotalMs(g, settings) {
  if (g.stage === "submit") return settings.submitSec * 1000;
  if (g.stage === "placing") return turnNeedsHuman(g) ? settings.turnSec * 1000 : 0;
  return 0;
}

/* ---------- 화면: 홈 ---------- */
function homeHtml(message) {
  const name = LS.get("h13:name") || "";
  return `
  <section class="home">
    <div>
      <div class="title-wrap"><div class="ceiling" aria-hidden="true"></div><h1 class="title">무거운 <span class="num">13</span></h1></div>
      <p class="lede">받침대에 올린 바위 무게가 13을 넘으면, 그 바위를 올린 사람이 벌점을 떠안습니다. 카드와 칩을 몰래 내고, 놓는 순서와 패스로 벌점을 남에게 넘기는 2~7인 심리전입니다.</p>
    </div>
    ${message ? `<div class="notice">${esc(message)}</div>` : ""}
    <div class="home-forms">
      <div class="field">
        <label for="name">닉네임</label>
        <input id="name" class="input" maxlength="10" autocomplete="nickname" placeholder="최대 10자" value="${esc(name)}" />
      </div>
      <button class="btn primary" data-act="create">새 방 만들기</button>
      <div class="divider">초대받은 방이 있다면</div>
      <div class="row">
        <input id="code" class="input code grow" maxlength="4" placeholder="ABCD" aria-label="방 코드" autocomplete="off" />
        <button class="btn" data-act="enter">코드로 들어가기</button>
      </div>
      <div><button class="link" data-act="rules">규칙 보기</button></div>
    </div>
  </section>`;
}

/* ---------- 화면: 로비 ---------- */
function playersListHtml(v, canKick) {
  return `<ul class="plist">${v.players.map((p) => `
    <li>
      ${swatch(p.color)}
      <span class="name">${esc(p.name)}</span>
      ${p.id === v.hostId ? `<span class="tag host">방장</span>` : ""}
      ${v.me && p.id === v.me.id ? `<span class="tag">나</span>` : ""}
      <i class="dot ${p.online ? "on" : ""}" title="${p.online ? "접속 중" : "접속 끊김"}"></i>
      ${canKick && p.id !== v.me.id ? `<button class="btn small ghost" data-act="kick" data-id="${p.id}">내보내기</button>` : ""}
    </li>`).join("")}</ul>`;
}

function segHtml(key, options, current, unit, enabled) {
  return `<div class="seg" role="group">${options.map((o) => `<button ${enabled ? "" : "disabled"} data-act="set" data-key="${key}" data-val="${o}" aria-pressed="${String(o) === String(current)}">${unit(o)}</button>`).join("")}</div>`;
}

function lobbyHtml(v) {
  const host = v.me.isHost;
  const s = v.settings;
  const enough = v.players.length >= 2;
  return `
  <section class="lobby">
    <div>
      <p class="muted small" style="margin:0">방 코드</p>
      <p class="code-big">${esc(v.code)}</p>
      <div class="row" style="margin-top:12px">
        <button class="btn" data-act="copy">초대 링크 복사</button>
        <button class="link" data-act="rules">규칙 보기</button>
      </div>
    </div>
    <div>
      <h2 style="margin:0 0 10px;font-size:18px">참가자 ${v.players.length}명 <span class="muted small">(최대 7명)</span></h2>
      ${playersListHtml(v, host)}
    </div>
    <div class="settings">
      <div class="field"><label>카드 고르는 시간</label>${segHtml("submitSec", [30, 60, 90, 180], s.submitSec, (o) => ({ 30: "30초", 60: "1분", 90: "1분 30초", 180: "3분" })[o], host)}</div>
      <div class="field"><label>놓기·패스 고르는 시간</label>${segHtml("turnSec", [10, 20, 30], s.turnSec, (o) => `${o}초`, host)}</div>
      <div class="field"><label>다른 사람의 남은 카드·칩 표시</label>${segHtml("showHands", [true, false], s.showHands, (o) => (o ? "보이기" : "숨기기 (기억력 승부)"), host)}</div>
      ${host ? "" : `<p class="muted small" style="margin:0">설정은 방장이 바꿀 수 있어요.</p>`}
    </div>
    <div class="row">
      ${host
        ? `<button class="btn primary" data-act="start" ${enough ? "" : "disabled"}>게임 시작</button>${enough ? "" : `<span class="muted small">2명 이상이면 시작할 수 있어요</span>`}`
        : `<p class="muted" style="margin:0">방장이 게임을 시작하면 바로 넘어가요.</p>`}
    </div>
    <div><button class="link" data-act="leave">방 나가기</button></div>
  </section>`;
}

function joinHtml(v) {
  const name = LS.get("h13:name") || "";
  return `
  <section class="lobby">
    <div>
      <p class="muted small" style="margin:0">초대받은 방</p>
      <p class="code-big">${esc(v.code)}</p>
    </div>
    <div id="join-players">${playersListHtml(v, false)}</div>
    <div class="home-forms">
      <div class="field">
        <label for="name">닉네임</label>
        <input id="name" class="input" maxlength="10" autocomplete="nickname" placeholder="최대 10자" value="${esc(name)}" />
      </div>
      <button class="btn primary" data-act="join">이 방에 들어가기</button>
      <div class="row"><button class="link" data-act="home">처음 화면으로</button><button class="link" data-act="rules">규칙 보기</button></div>
    </div>
  </section>`;
}

/* ---------- 화면: 게임 ---------- */
function setBar(g) {
  let out = "";
  for (let r = 0; r < g.rounds; r++) {
    if (r === g.perSet) out += `<i class="gap"></i>`;
    const cls = g.stage === "ended" || r < g.round ? "done" : r === g.round ? "now" : "";
    out += `<i class="${cls}"></i>`;
  }
  return `<span class="setbar" aria-hidden="true">${out}</span>`;
}

function playerCards(v) {
  const g = v.game;
  const mySeat = v.me ? v.me.seat : -1;
  const placedSet = new Set(g.placements.map((p) => p.p));
  return `<div class="players">${g.seats.map((s) => {
    const pk = g.picks[s.seat];
    const orderIdx = g.order.indexOf(s.seat);
    let state = "";
    if (g.stage === "submit") state = s.submitted ? `<span class="ok">제출 완료</span>` : "고르는 중";
    else if (g.stage === "ended") state = "";
    else if (pk) {
      state = `${chipDot(pk.chip)}${cardFace(pk.card)}`;
      if (orderIdx >= 0) state += `<span class="order-no" title="놓는 순서">${orderIdx + 1}번째</span>`;
      if (g.turn === s.seat) state += `<span class="ok">놓는 중</span>`;
      else if (placedSet.has(s.seat)) {
        const pl = g.placements.find((p) => p.p === s.seat);
        state += pl.passed ? `<span>패스 후 놓음</span>` : `<span>놓음</span>`;
      } else if (g.passed.includes(s.seat)) state += `<span>패스</span>`;
    }
    let hand = "";
    if (s.hand && s.seat !== mySeat && g.stage !== "ended") {
      const cards = [0, 1, 2, 3, 4, 5, 6].map((c) => `<span class="${s.hand.cards.includes(c) ? "" : "used"}">${c}</span>`).join("");
      const chips = ["red", "green", "blue", "rainbow"].flatMap((c) => Array(s.hand.chips[c]).fill(`<i class="c-${c}"></i>`)).join("");
      hand = `<div class="mini-hand" title="남은 카드와 칩"><span class="cards">${cards}</span><span class="mini-chips">${chips}</span></div>`;
    }
    const cls = ["pc", s.seat === mySeat ? "me" : "", g.turn === s.seat ? "turn" : ""].join(" ");
    return `
    <div class="${cls}">
      <div class="pc-head">${swatch(s.color)}<span class="pc-name">${esc(s.name)}</span>${s.seat === mySeat ? `<span class="tag">나</span>` : ""}${g.first === s.seat && g.stage !== "ended" ? `<span class="marker" title="선 플레이어">선</span>` : ""}<i class="dot ${s.online ? "on" : ""}" title="${s.online ? "접속 중" : "접속 끊김"}"></i></div>
      <div class="pc-pen"><span class="pts">${s.points}<small>점</small></span>${tally(s.points)}</div>
      <div class="pc-state">${state}</div>
      ${hand}
    </div>`;
  }).join("")}</div>`;
}

function standsHtml(v) {
  const g = v.game;
  const now = Date.now();
  return `<div class="stands">${COLORS.map((c) => {
    const rocks = g.stands[c];
    const sum = standSum(rocks);
    const zeros = rocks.filter((r) => r.w === 0).length;
    const extra = zeros * 5 + Math.max(rocks.length - 1, 0) * 2;
    const bust = S.fx.bust[c] && now - S.fx.bust[c].at < 1800 ? S.fx.bust[c] : null;
    const drop = S.fx.drop && S.fx.drop.stand === c && now - S.fx.drop.at < 600 ? S.fx.drop : null;
    const rockHtml = rocks.map((r, i) => {
      const seat = g.seats[r.seat] || { name: "?", color: 0 };
      const isTop = i === rocks.length - 1;
      const anim = drop && isTop ? `drop" style="--w:${r.w};--pc:var(--p${seat.color});animation-delay:-${now - drop.at}ms` : `" style="--w:${r.w};--pc:var(--p${seat.color})`;
      const thin = r.w <= 1 ? (r.w === 0 ? " zero thin" : " thin") : "";
      return `<div class="rock${thin} ${anim}" title="${esc(seat.name)}의 바위 ${r.w}"><span class="w">${r.w}</span><span class="who">${esc(seat.name)}</span></div>`;
    }).join("");
    const left = LIMIT - sum;
    return `
    <div class="stand s-${c} ${bust ? "bust" : ""}">
      <div class="gauge" style="min-height:calc(var(--u) * 13 + ${extra + 40}px)${bust ? `;animation-delay:-${now - bust.at}ms` : ""}" aria-label="${KO[c]} 받침대 합 ${sum}">
        ${rockHtml}
        <div class="limit" style="bottom:calc(var(--u) * 13 + ${extra + (rocks.length ? 2 : 0)}px)"><span>13</span></div>
        ${bust ? `<div class="bust-note" style="animation-delay:-${now - bust.at}ms">${esc(bust.text)}</div>` : ""}
      </div>
      <div class="stand-foot"><span class="stand-name">${KO[c]}</span><span class="sum">${sum}</span><span class="room ${left <= 3 ? "tight" : ""}">여유 ${left}</span></div>
    </div>`;
  }).join("")}</div>`;
}

function placementLine(g, pl) {
  const name = esc(g.seats[pl.p]?.name);
  const what = `${chipDot(pl.chip)}<b>${name}</b> ${KO[pl.stand]}에 ${pl.card}`;
  if (pl.cleared > 0) return `<li>${what} <span class="pen">${pl.sum}이 되어 벌점 +${pl.cleared}</span>${pl.passed ? `<span class="passed">(패스했던 바위)</span>` : ""}</li>`;
  return `<li>${what} <span class="passed">합 ${pl.sum}${pl.passed ? ", 패스했던 바위" : ""}</span></li>`;
}

function roundLogHtml(v) {
  const g = v.game;
  if (!["placing", "roundEnd"].includes(g.stage)) return "";
  const lines = g.placements.map((pl) => placementLine(g, pl));
  const waiting = g.passed.filter((p) => !g.placements.some((x) => x.p === p));
  if (waiting.length) lines.push(`<li class="passed">패스: ${waiting.map((p) => esc(g.seats[p].name)).join(", ")} (나중에 패스한 사람부터 놓아요)</li>`);
  if (!lines.length) return "";
  return `<div class="panel"><h3>이번 라운드</h3><ul class="log">${lines.join("")}</ul></div>`;
}

function historyHtml(v, open) {
  const g = v.game;
  if (!g.history.length) return "";
  if (!open) return "";
  const head = g.seats.map((s) => `<th>${swatch(s.color)} ${esc(s.name)}</th>`).join("");
  const autoSet = new Set((g.auto?.submits || []).map((a) => `${a.round}-${a.seat}`));
  const rows = g.history.map((r) => {
    const cells = g.seats.map((s) => {
      const pk = r.picks[s.seat];
      const pl = r.placements.find((x) => x.p === s.seat);
      const passIdx = r.passes.indexOf(s.seat);
      return `<td>${chipDot(pk.chip)} ${pk.card}${pk.chip === "rainbow" && pl ? ` <span class="muted">${KO[pl.stand]}</span>` : ""}${passIdx >= 0 ? ` <span class="muted">패스</span>` : ""}${pl && pl.cleared ? ` <span class="pen">+${pl.cleared}</span>` : ""}${autoSet.has(`${r.round}-${s.seat}`) ? ` <span class="muted">자동</span>` : ""}</td>`;
    }).join("");
    return `<tr><td class="num">${r.round + 1}</td><td>${esc(g.seats[r.first].name)}</td>${cells}</tr>`;
  }).join("");
  const totals = g.seats.map((s) => `<td><b>${s.points}점</b></td>`).join("");
  return `<div class="panel"><h3>라운드 기록</h3><div class="table-wrap"><table>
    <thead><tr><th class="num">R</th><th>선</th>${head}</tr></thead>
    <tbody>${rows}<tr><td></td><td class="muted">합계</td>${totals}</tr></tbody></table></div></div>`;
}

function previewText(g, stand, w) {
  const rocks = g.stands[stand];
  const sum = standSum(rocks) + w;
  if (sum >= LIMIT) return { text: `올리면 ${sum}, 벌점 ${rocks.length}`, danger: true };
  return { text: `올리면 합 ${sum}`, danger: false };
}

function dockHtml(v) {
  const g = v.game;
  const s = v.settings;
  const me = v.me && v.me.seat >= 0 ? v.me : null;
  const total = stageTotalMs(g, s);
  const bar = total ? timerBar(g.until, total) : "";
  const msg = (text) => `<div class="dock-msg">${text}${total ? secsSpan(g.until) : ""}</div>`;
  const nameOf = (seat) => esc(g.seats[seat]?.name);
  let body = "";

  if (g.stage === "submit") {
    const done = g.seats.filter((x) => x.submitted).length;
    const myPick = me ? g.picks[me.seat] : null;
    if (!me) body = msg(`모두 카드를 고르는 중이에요 (${done}/${g.seats.length}명 제출)`);
    else if (myPick) body = msg(`${chipDot(myPick.chip)}${cardFace(myPick.card)} 냈어요. 다른 사람을 기다리는 중 (${done}/${g.seats.length}명)`);
    else {
      const h = g.myHand;
      const sel = S.sel;
      const cards = [0, 1, 2, 3, 4, 5, 6].map((c) => `<button class="card-btn" data-act="pick-card" data-val="${c}" aria-pressed="${sel.card === c}" ${h.cards.includes(c) ? "" : "disabled"} aria-label="카드 ${c}">${c}</button>`).join("");
      const chips = ["red", "green", "blue", "rainbow"].map((c) => `<button class="chip-btn c-${c}" data-act="pick-chip" data-val="${c}" aria-pressed="${sel.chip === c}" ${h.chips[c] > 0 ? "" : "disabled"} aria-label="${KO[c]} 칩 ${h.chips[c]}개"><span class="n">${h.chips[c]}</span></button>`).join("");
      let hint = "카드 1장과 칩 1개를 고르세요";
      if (sel.card !== null && sel.chip && sel.chip !== "rainbow") {
        const now = standSum(g.stands[sel.chip]);
        hint = `지금 ${KO[sel.chip]}은 ${now}. 바로 올리면 ${now + sel.card}${now + sel.card >= LIMIT ? "이라 위험해요" : ""} (먼저 놓는 사람에 따라 달라져요)`;
      } else if (sel.chip === "rainbow") hint = "레인보우는 가장 먼저 놓고, 받침대를 그때 골라요";
      const ready = sel.card !== null && sel.chip;
      body = `${msg(hint)}
        <div class="pick-row">${cards}</div>
        <div class="row"><div class="pick-row">${chips}</div><span class="grow"></span><button class="btn primary" data-act="submit" ${ready && !S.busy ? "" : "disabled"}>이걸로 내기</button></div>`;
    }
  } else if (g.stage === "revealChips") {
    body = msg("칩을 공개해요");
  } else if (g.stage === "revealCards") {
    body = msg(`카드 공개. 놓는 순서: ${g.order.map((p, i) => `${i + 1}. ${nameOf(p)}`).join("  ")}`);
  } else if (g.stage === "placing") {
    const a = g.asked;
    if (a && me && !a.canPass && !a.needStand) {
      const pk = g.picks[me.seat];
      body = msg(`${chipDot(pk.chip)}${cardFace(pk.card)} ${a.passedRock ? "패스했던 내 바위를 놓아요" : "남은 사람이 나뿐이라 바로 놓아요"}`);
    } else if (a && me) {
      const pk = g.picks[me.seat];
      const stands = a.needStand ? COLORS : [pk.chip];
      const choices = stands.map((c) => {
        const pv = previewText(g, c, pk.card);
        return `<button class="choice s-${c} ${pv.danger ? "danger" : ""}" data-act="place" data-stand="${c}" ${S.busy ? "disabled" : ""}><b>${KO[c]}에 ${pk.card} 놓기</b><span>${pv.text}</span></button>`;
      });
      if (a.canPass) {
        const left = g.queue.length - 1;
        choices.push(`<button class="choice pass" data-act="pass" ${S.busy ? "disabled" : ""}><b>패스</b><span>남은 ${left}명이 먼저 놓아요</span></button>`);
      }
      body = `${msg(`<b>내 차례예요.</b> ${chipDot(pk.chip)}${cardFace(pk.card)}`)}<div class="choice-row">${choices.join("")}</div>`;
    } else if (g.turn !== null) {
      const pk = g.picks[g.turn];
      const waitingMine = me && g.passed.includes(me.seat) ? " 내가 패스한 바위는 맨 뒤에 놓여요." : "";
      body = msg(`<b>${nameOf(g.turn)}</b> 차례 ${chipDot(pk.chip)}${cardFace(pk.card)}${waitingMine}`);
    }
  } else if (g.stage === "roundEnd") {
    const pens = g.placements.filter((p) => p.cleared > 0);
    const penText = pens.length ? pens.map((p) => `${nameOf(p.p)} +${p.cleared}`).join(", ") : "이번 라운드는 벌점이 없어요";
    const refill = (g.round + 1) % g.perSet === 0 && g.round + 1 < g.rounds ? " 다음 라운드에 카드와 칩을 새로 받아요." : "";
    const last = g.round + 1 >= g.rounds;
    body = msg(`<b>${g.round + 1}라운드 끝.</b> ${penText}. ${last ? "곧 결과가 나와요." : `다음 선은 ${nameOf(g.first)}.${refill}`}`);
  }
  return `<div class="dock"><div class="dock-inner">${bar}${body}</div></div>`;
}

function topbarHtml(g) {
  return `<div class="topbar">
    <span class="round">${Math.min(g.round + 1, g.rounds)}<small>/ ${g.rounds} 라운드</small></span>
    ${setBar(g)}
    <span class="spacer"></span>
    <button class="btn small ghost" data-act="history" aria-pressed="${S.showHistory}">${S.showHistory ? "기록 닫기" : "기록 보기"}</button>
    <button class="btn small ghost" data-act="rules">규칙</button>
  </div>`;
}

function gameHtml(v) {
  const g = v.game;
  const spectator = !v.me || v.me.seat < 0;
  return `
    ${topbarHtml(g)}
    ${spectator ? `<p class="spectate">관전 중이에요. 이번 판이 끝나면 방장이 다음 판을 열 때 들어올 수 있어요.</p>` : ""}
    ${S.netError ? `<div class="notice">연결이 불안정해요. 다시 연결하는 중…</div>` : ""}
    ${playerCards(v)}
    ${standsHtml(v)}
    ${roundLogHtml(v)}
    ${historyHtml(v, S.showHistory)}
    ${dockHtml(v)}`;
}

function resultHtml(v) {
  const g = v.game;
  const rows = g.standings;
  const lastPlace = Math.max(...rows.map((r) => r.place));
  const tieNote = rows.some((r, i) => i > 0 && rows[i - 1].points === r.points && rows[i - 1].place !== r.place);
  const host = v.me?.isHost;
  return `
  <section class="result">
    <h1 class="title" style="font-size:clamp(48px,12vw,88px)">결과</h1>
    <ol class="podium">${rows.map((r) => {
      const s = g.seats[r.p];
      return `<li class="${r.place === 1 ? "first" : ""} ${r.place === lastPlace && rows.length > 1 && lastPlace !== 1 ? "lastp" : ""}">
        <span class="place">${r.place}</span>
        <span>${swatch(s.color)} <b>${esc(s.name)}</b>${v.me && s.id === v.me.id ? ` <span class="tag">나</span>` : ""}</span>
        <span class="pts">${r.points}<small>점</small></span>
      </li>`;
    }).join("")}</ol>
    ${tieNote ? `<p class="muted small" style="margin:0">벌점이 같으면 더 최근에 벌점을 받은 사람이 아래 순위예요.</p>` : ""}
    <div class="row">
      ${host ? `<button class="btn primary" data-act="rematch">한 판 더 하기</button>` : `<span class="muted">방장이 한 판 더 열면 같은 방에서 이어서 해요.</span>`}
      <button class="link" data-act="home">처음 화면으로</button>
    </div>
    ${standsHtml(v)}
    ${historyHtml(v, true)}
  </section>`;
}

function setupHtml() {
  return `<section class="lobby">
    <h1 class="title" style="font-size:clamp(40px,10vw,72px)">저장소 연결이 필요해요</h1>
    <div class="notice">
      여러 명이 같은 판을 보려면 Vercel에 Redis 저장소를 한 번 연결해야 해요.
      <ol>
        <li>Vercel에서 이 프로젝트를 열고 <b>Storage</b> 탭으로 갑니다.</li>
        <li><b>Upstash for Redis</b>를 골라 무료(Free) 플랜으로 만들고, 이 프로젝트에 연결합니다.</li>
        <li><b>Deployments</b>에서 최신 배포를 <b>Redeploy</b> 합니다.</li>
      </ol>
    </div>
    <div><button class="btn" data-act="reload">다시 확인하기</button></div>
  </section>`;
}

/* ---------- 렌더 ---------- */
function render() {
  let screen;
  let html;
  const v = S.view;
  if (S.setup) { screen = "setup"; html = setupHtml(); }
  else if (!S.code) { screen = "home"; }
  else if (!v) { screen = "loading"; html = `<p class="muted">방을 불러오는 중…</p>`; }
  else if (v.status === "lobby" && !v.me) { screen = "join"; }
  else if (v.status === "lobby") { screen = "lobby"; html = lobbyHtml(v); }
  else if (v.status === "ended") { screen = "result"; html = resultHtml(v); }
  else { screen = "game"; html = gameHtml(v); }

  // 입력칸이 있는 화면은 처음 한 번만 그리고, 이후엔 바뀌는 부분만 갱신
  if (screen === "home") {
    if (S.screen !== "home") { app.innerHTML = homeHtml(S.homeMessage); S.homeMessage = null; }
    S.screen = screen;
    return;
  }
  if (screen === "join") {
    if (S.screen !== "join") app.innerHTML = joinHtml(v);
    else document.getElementById("join-players").innerHTML = playersListHtml(v, false);
    S.screen = screen;
    return;
  }
  const fxKey = JSON.stringify([Object.keys(S.fx.bust).filter((c) => Date.now() - S.fx.bust[c].at < 1800), S.fx.drop && Date.now() - S.fx.drop.at < 600]);
  const key = JSON.stringify([screen, v && { ...v, serverNow: 0 }, S.sel, S.showHistory, S.busy, S.netError, fxKey]);
  if (key === S.renderKey && S.screen === screen) return;
  S.renderKey = key;
  S.screen = screen;
  app.innerHTML = html;
  // 하단 고정 패널 높이만큼 아래 여백을 줘서 받침대가 가려지지 않게
  const dock = app.querySelector(".dock");
  app.style.paddingBottom = dock ? `${dock.offsetHeight + 20}px` : "";
  tick();
}

/* 남은 시간 표시 */
function tick() {
  const now = serverNow();
  document.querySelectorAll("[data-until]").forEach((el) => {
    const until = Number(el.dataset.until);
    const total = Number(el.dataset.total) || 1;
    const left = Math.max(0, until - now);
    el.querySelector("i").style.transform = `scaleX(${Math.min(1, left / total)})`;
    el.classList.toggle("low", left < 5000);
  });
  document.querySelectorAll("[data-secs]").forEach((el) => {
    const left = Math.max(0, Math.ceil((Number(el.dataset.secs) - now) / 1000));
    el.textContent = left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : `${left}초`;
  });
}
setInterval(tick, 250);

/* ---------- 행동 ---------- */
function leaveRoom(message) {
  clearTimeout(S.pollTimer);
  S.code = null;
  S.token = null;
  S.view = null;
  S.screen = null;
  S.homeMessage = message || null;
  history.replaceState(null, "", location.pathname);
  render();
}

function enterRoom(code, token, view) {
  S.code = code;
  S.token = token || null;
  if (token) LS.set(`h13:t:${code}`, token);
  history.replaceState(null, "", `${location.pathname}?room=${code}`);
  S.screen = null;
  if (view) accept(view);
  poll();
}

async function act(payload) {
  if (S.busy) return null;
  S.busy = true;
  render();
  try {
    const res = await api("POST", { code: S.code, token: S.token || "", ...payload });
    S.busy = false;
    if (res.view) accept(res.view);
    else render();
    return res;
  } catch (e) {
    S.busy = false;
    if (e.setup) S.setup = true;
    toast(e.message);
    render();
    return null;
  }
}

function readName() {
  const el = document.getElementById("name");
  const name = (el?.value || "").trim();
  if (!name) { toast("닉네임을 입력해 주세요"); el?.focus(); return null; }
  LS.set("h13:name", name);
  return name;
}

async function copyLink() {
  const url = `${location.origin}${location.pathname}?room=${S.code}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("초대 링크를 복사했어요");
  } catch {
    prompt("이 링크를 복사해서 보내 주세요", url);
  }
}

app.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-act]");
  if (!btn || btn.disabled) return;
  const a = btn.dataset.act;
  if (a === "rules") return rulesDialog.showModal();
  if (a === "history") { S.showHistory = !S.showHistory; return render(); }
  if (a === "copy") return copyLink();
  if (a === "home") return leaveRoom();
  if (a === "reload") {
    S.setup = false;
    S.screen = null;
    if (S.code) return poll();
    return render();
  }
  if (a === "pick-card") { S.sel.card = Number(btn.dataset.val); return render(); }
  if (a === "pick-chip") { S.sel.chip = btn.dataset.val; return render(); }

  if (a === "create") {
    const name = readName();
    if (!name || S.busy) return;
    S.busy = true;
    try {
      const res = await api("POST", { action: "create", name });
      S.busy = false;
      enterRoom(res.code, res.token, res.view);
    } catch (e) {
      S.busy = false;
      if (e.setup) { S.setup = true; render(); } else toast(e.message);
    }
    return;
  }
  if (a === "enter") {
    const code = cleanCode(document.getElementById("code")?.value);
    if (code.length !== 4) return toast("방 코드 4자리를 입력해 주세요");
    readName();
    return enterRoom(code, LS.get(`h13:t:${code}`));
  }
  if (a === "join") {
    const name = readName();
    if (!name) return;
    const res = await act({ action: "join", name });
    if (res?.token) { S.token = res.token; LS.set(`h13:t:${S.code}`, res.token); poll(); }
    return;
  }
  if (a === "leave") {
    const res = await act({ action: "leave" });
    if (res) { LS.del(`h13:t:${S.code}`); leaveRoom(); }
    return;
  }
  if (a === "kick") return act({ action: "kick", id: btn.dataset.id });
  if (a === "set") {
    const key = btn.dataset.key;
    let val = btn.dataset.val;
    val = key === "showHands" ? val === "true" : Number(val);
    return act({ action: "settings", settings: { [key]: val } });
  }
  if (a === "start") return act({ action: "start" });
  if (a === "submit") {
    if (S.sel.card === null || !S.sel.chip) return;
    return act({ action: "submit", card: S.sel.card, chip: S.sel.chip });
  }
  if (a === "place") return act({ action: "place", stand: btn.dataset.stand });
  if (a === "pass") return act({ action: "pass" });
  if (a === "rematch") return act({ action: "rematch" });
});

app.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter") return;
  if (ev.target.id === "code") app.querySelector('[data-act="enter"]')?.click();
  if (ev.target.id === "name") app.querySelector('[data-act="join"], [data-act="create"]')?.click();
});

render();
if (S.code) poll();
