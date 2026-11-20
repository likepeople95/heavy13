// 무거운 13 — 화면
const COLORS = ["red", "green", "blue"];
const KO = { red: "빨강", green: "초록", blue: "파랑", rainbow: "레인보우" };
const LIMIT = 13;
const DROP_MS = 650;
const BUST_MS = 2500;

const app = document.getElementById("app");
const dockRoot = document.getElementById("dock-root");
const toastBox = document.getElementById("toast");
const rulesDialog = document.getElementById("rules");
const callEl = document.getElementById("call");
const confirmDialog = document.getElementById("confirm");

const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 저장 불가 환경 */ } },
};

const cleanCode = (x) => String(x || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const initial = (name) => Array.from(String(name || "?"))[0];

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
  dockHtml: "",
  screen: null,
  showHistory: false,
  seen: null, // 마지막으로 본 놓기 수 (연출 감지용)
  fx: { bust: {}, drop: null },
  stageKey: null,
  stageAt: 0,
  noticeId: undefined,
  homeMessage: null,
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
  const prev = S.view;
  S.offset = view.serverNow - Date.now();
  S.setup = false;
  if (S.token && !view.me) { LS.del(`h13:t:${S.code}`); S.token = null; }
  detectFx(view);
  detectMoments(prev, view);
  const g = view.game;
  if (g && S.selRound !== `${g.gameNo}-${g.round}`) {
    S.sel = { card: null, chip: null };
    S.selRound = `${g.gameNo}-${g.round}`;
  }
  S.view = view;
  render();
}

/** 새로 놓인 돌·벌점을 찾아 짧은 연출을 건다 */
function detectFx(view) {
  const g = view.game;
  if (!g) { S.seen = null; return; }
  const key = `${g.gameNo}-${g.round}`;
  const n = g.placements.length;
  if (!S.seen || S.seen.key !== key) S.seen = { key, n: S.seen ? 0 : n }; // 처음 들어왔을 땐 지난 것을 연출하지 않음
  if (n <= S.seen.n) return;
  const now = Date.now();
  for (const pl of g.placements.slice(S.seen.n)) {
    S.fx.drop = { stand: pl.stand, at: now };
    if (pl.cleared > 0) {
      S.fx.bust[pl.stand] = {
        at: now,
        cleared: pl.cleared,
        name: g.seats[pl.p]?.name || "",
        rocks: (pl.clearedRocks || []).map((r) => toRock(g, r.p, r.w)),
      };
    }
  }
  S.seen.n = n;
  setTimeout(render, DROP_MS + 20);
  setTimeout(render, BUST_MS + 20);
}

/** 진행 발표(라운드 시작·공개·종료)와 공지(중단·방장 변경) */
function detectMoments(prev, v) {
  const n = v.notice;
  if (S.noticeId === undefined) S.noticeId = n?.id ?? null; // 처음 접속: 지난 공지는 띄우지 않음
  else if (n && n.id !== S.noticeId) {
    S.noticeId = n.id;
    if (n.kind === "aborted") announce("게임 중단", `방장이 ${n.round}라운드에서 중단했어요`, "alert", 1900);
    if (n.kind === "host") toast(`${n.name}님이 이제 방장이에요`);
  }

  const g = v.game;
  const key = g ? `${g.gameNo}-${g.round}-${g.stage}` : null;
  const turnCall = () => announce("내 차례", g.asked.needStand ? "받침대를 고르세요" : "놓을지 패스할지 고르세요", "gold", 1000);
  if (key === S.stageKey) {
    // 같은 단계 안에서 내 차례가 새로 왔을 때
    if (g?.asked && !prev?.game?.asked && (g.asked.canPass || g.asked.needStand)) turnCall();
    return;
  }
  S.stageKey = key;
  S.stageAt = Date.now();
  if (!prev || !g) return;
  const name = (seat) => g.seats[seat]?.name || "";
  if (g.stage === "submit") {
    if (g.round === 0) announce("게임 시작", `1라운드. 선은 ${name(g.first)}`, "gold", 1700);
    else if (g.round === g.rounds - 1) announce(`${g.round + 1}라운드`, "마지막 라운드예요", "gold");
    else if (g.round === g.perSet) announce(`${g.round + 1}라운드`, "카드와 칩을 새로 받았어요");
    else announce(`${g.round + 1}라운드`, `선은 ${name(g.first)}`);
  } else if (g.stage === "revealChips") announce("칩 공개", "", "", 1300);
  else if (g.stage === "revealCards") announce("카드 공개", `놓는 순서 ${g.order.map((p, i) => `${i + 1}.${name(p)}`).join("  ")}`, "", 1700);
  else if (g.stage === "ended") announce("게임 종료", "결과를 발표합니다", "gold", 1800);
  else if (g.stage === "placing" && g.asked && (g.asked.canPass || g.asked.needStand)) turnCall();
}

let callTimer = null;
function announce(title, sub, tone = "", ms = 1500) {
  callEl.innerHTML = `<div class="call-band ${tone}" style="--cd:${ms}ms"><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ""}</div>`;
  callEl.classList.add("show");
  clearTimeout(callTimer);
  callTimer = setTimeout(() => { callEl.classList.remove("show"); callEl.innerHTML = ""; }, ms);
}

function toast(msg) {
  const d = document.createElement("div");
  d.textContent = msg;
  toastBox.appendChild(d);
  setTimeout(() => d.remove(), 3200);
}

function confirmBox(title, body, okLabel) {
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-body").textContent = body;
  document.getElementById("confirm-ok").textContent = okLabel;
  confirmDialog.returnValue = "";
  confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "ok"), { once: true });
  });
}

/* ---------- 부품 ---------- */
const TILTS = [-1.8, 1.3, -0.6, 2.1, -1.2, 0.7, -2.3, 1.0, 0.3, -0.9, 1.7];
const toRock = (g, seat, w) => {
  const s = g.seats[seat] || { name: "?", color: 0 };
  return { w, name: s.name, color: s.color };
};

function rockHtml(r, i, cls = "", style = "") {
  const tilt = TILTS[(i * 3 + r.w) % TILTS.length];
  return `<div class="rock t${(i + r.w) % 3} ${cls}" style="--pc:var(--p${r.color});--tilt:${tilt}deg;${style}" title="${esc(r.name)}의 돌 ${r.w}"><span class="w">${r.w}</span><i class="own">${esc(initial(r.name))}</i></div>`;
}

function standHtml(c, rocks, fx = {}) {
  const now = Date.now();
  const sum = rocks.reduce((s, r) => s + r.w, 0);
  const left = LIMIT - sum;
  const tight = left <= 3;
  const drop = fx.drop && fx.drop.stand === c && now - fx.drop.at < DROP_MS ? now - fx.drop.at : null;
  const bust = fx.bust && fx.bust[c] && now - fx.bust[c].at < BUST_MS ? fx.bust[c] : null;
  const bustEl = bust ? now - bust.at : 0;
  const pile = rocks.map((r, i) => (drop !== null && i === rocks.length - 1 ? rockHtml(r, i, "drop", `--dd:-${drop}ms`) : rockHtml(r, i))).join("");
  const ghosts = bust
    ? `<div class="ghosts">${bust.rocks.map((r, i) => rockHtml(r, i, "", `--d:${i * 40 - bustEl}ms;--dx:${(i % 2 ? 1 : -1) * (14 + i * 6)}px;--rot:${(i % 2 ? 1 : -1) * (24 + i * 11)}deg`)).join("")}</div>
       <div class="stamp" style="--bd:-${bustEl}ms">벌점 +${bust.cleared}<small>${esc(bust.name)}</small></div>`
    : "";
  return `
  <div class="stand s-${c} ${tight ? "tight" : ""} ${bust ? "bust" : ""}" style="--bd:-${bustEl}ms" aria-label="${KO[c]} 받침대 합 ${sum}, 돌 ${rocks.length}개">
    <div class="stand-top"><span class="plaque">${KO[c]}</span><span class="sum">${sum}<small>/13</small></span></div>
    <div class="rig">
      <div class="pile">${pile}${ghosts}</div>
      <div class="meter" aria-hidden="true"><i class="fill" style="height:${(Math.min(sum, LIMIT) / LIMIT) * 100}%"></i><i class="cap"></i></div>
    </div>
    <div class="porter" aria-hidden="true"></div>
    <div class="stand-foot"><span class="left">여유 <b>${left}</b></span><span title="13 이상이 되면 이 개수만큼 벌점">돌 <b>${rocks.length}</b>개</span></div>
  </div>`;
}

function gameStandsHtml(v) {
  const g = v.game;
  return `<div class="stands">${COLORS.map((c) => standHtml(c, g.stands[c].map((r) => toRock(g, r.seat, r.w)), S.fx)).join("")}</div>`;
}

function tally(points) {
  if (points <= 0 || points > 25) return "";
  const strokes = ["M3 3H17", "M10 3V17", "M10 10H15", "M5 10V17", "M2 17H18"];
  let out = "";
  for (let left = points; left > 0; left -= 5) {
    const k = Math.min(5, left);
    out += `<svg viewBox="0 0 20 20" aria-hidden="true">${strokes.slice(0, k).map((d) => `<path d="${d}" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`).join("")}</svg>`;
  }
  return `<span class="tally" title="벌점 ${points}">${out}</span>`;
}

const chipEl = (chip, cls = "", style = "") => `<i class="chip c-${chip} ${cls}" style="${style}" title="${KO[chip]}" aria-label="${KO[chip]} 칩"></i>`;
const cardEl = (n, cls = "", style = "") => (n === null || n === undefined ? `<span class="tablet back ${cls}" aria-label="뒤집힌 카드">?</span>` : `<span class="tablet ${cls}" style="${style}">${n}</span>`);
const badge = (name, color) => `<i class="badge" style="--pc:var(--p${color})">${esc(initial(name))}</i>`;

function timerBar(until, totalMs) {
  if (!until || !totalMs) return "";
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

function hostAwayHtml(v) {
  if (!v.me || v.me.isHost || !v.hostAway) return "";
  const host = v.players.find((p) => p.id === v.hostId);
  return `<div class="notice">${esc(host?.name || "방장")}님이 30초 넘게 접속하지 않았어요. 필요하면 대신 방장을 맡을 수 있어요.
    <div class="row"><button class="btn small" data-act="claim">내가 방장 맡기</button></div></div>`;
}

/* ---------- 화면: 홈 ---------- */
function homeHtml(message) {
  const name = LS.get("h13:name") || "";
  const sample = [
    { w: 3, name: "강", color: 0 }, { w: 4, name: "김", color: 1 }, { w: 1, name: "이", color: 2 },
    { w: 0, name: "박", color: 3 }, { w: 3, name: "최", color: 4 },
  ];
  return `
  <section class="home">
    <div>
      <h1 class="title">무거운 <span class="num">13</span></h1>
      <p class="lede">받침대 위 돌의 무게가 13이 되는 순간, 그 돌을 올린 사람이 받침대 위 돌을 전부 떠안습니다. 카드와 칩을 몰래 내고, 놓는 순서와 패스로 벌점을 남에게 넘기는 2~7인 심리전입니다.</p>
      ${message ? `<div class="notice" style="margin-top:20px">${esc(message)}</div>` : ""}
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
    </div>
    <div class="hero-stand" aria-hidden="true">${standHtml("red", sample)}</div>
  </section>`;
}

/* ---------- 화면: 로비 ---------- */
function abortedNoticeHtml(v) {
  const n = v.notice;
  if (!n || n.kind !== "aborted" || serverNow() - n.at > 120000) return "";
  return `<div class="notice alert">${esc(n.by)}님이 ${n.round}라운드에서 게임을 중단했어요. 같은 멤버로 바로 다시 시작할 수 있어요.</div>`;
}

function playersListHtml(v, host) {
  return `<ul class="plist">${v.players.map((p) => `
    <li>
      ${badge(p.name, p.color)}
      <span class="name">${esc(p.name)}</span>
      ${p.id === v.hostId ? `<span class="tag host">방장</span>` : ""}
      ${v.me && p.id === v.me.id ? `<span class="tag">나</span>` : ""}
      <i class="dot ${p.online ? "on" : ""}" title="${p.online ? "접속 중" : "접속 끊김"}"></i>
      ${host && p.id !== v.me.id ? `<button class="btn small ghost" data-act="transfer" data-id="${p.id}" data-name="${esc(p.name)}">방장 넘기기</button><button class="btn small ghost" data-act="kick" data-id="${p.id}">내보내기</button>` : ""}
    </li>`).join("")}</ul>`;
}

function segHtml(key, options, current, label, enabled) {
  return `<div class="seg" role="group">${options.map((o) => `<button ${enabled ? "" : "disabled"} data-act="set" data-key="${key}" data-val="${o}" aria-pressed="${String(o) === String(current)}">${label(o)}</button>`).join("")}</div>`;
}

function lobbyHtml(v) {
  const host = v.me.isHost;
  const s = v.settings;
  const enough = v.players.length >= 2;
  return `
  <section class="lobby">
    ${abortedNoticeHtml(v)}
    ${hostAwayHtml(v)}
    <div>
      <p class="muted small" style="margin:0 0 10px">방 코드</p>
      <div class="code-stone">${esc(v.code)}</div>
      <div class="row" style="margin-top:18px">
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
      <div class="field"><label>다른 사람의 남은 카드·칩</label>${segHtml("showHands", [true, false], s.showHands, (o) => (o ? "보이기" : "숨기기 (기억력 승부)"), host)}</div>
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
      <p class="muted small" style="margin:0 0 10px">초대받은 방</p>
      <div class="code-stone">${esc(v.code)}</div>
    </div>
    <div id="join-players">${playersListHtml(v, false)}</div>
    <div class="home-forms" style="margin-top:0">
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
function pipsHtml(g) {
  let out = "";
  for (let r = 0; r < g.rounds; r++) {
    if (r === g.perSet) out += `<i class="gap"></i>`;
    const cls = g.stage === "ended" || r < g.round ? "done" : r === g.round ? "now" : "";
    out += `<i class="${cls}"></i>`;
  }
  return `<span class="pips" aria-hidden="true">${out}</span>`;
}

function topbarHtml(v) {
  const g = v.game;
  const host = v.me?.isHost && v.status === "playing";
  return `<div class="topbar">
    <span class="round-no">${Math.min(g.round + 1, g.rounds)}<small>/${g.rounds}</small></span>
    ${pipsHtml(g)}
    <span class="spacer"></span>
    <button class="btn small ghost" data-act="history" aria-pressed="${S.showHistory}">${S.showHistory ? "기록 닫기" : "기록"}</button>
    <button class="btn small ghost" data-act="rules">규칙</button>
    ${host ? `<button class="btn small danger" data-act="abort">게임 중단</button>` : ""}
  </div>`;
}

function platesHtml(v) {
  const g = v.game;
  const mySeat = v.me ? v.me.seat : -1;
  const placed = new Map(g.placements.map((p) => [p.p, p]));
  const since = Date.now() - S.stageAt;
  return `<div class="plates">${g.seats.map((s) => {
    const pk = g.picks[s.seat];
    const orderIdx = g.order.indexOf(s.seat);
    let act = "";
    if (g.stage === "submit") act = s.submitted ? `<span class="ok">제출 완료</span>` : "고르는 중…";
    else if (pk && g.stage !== "ended") {
      const popCls = g.stage === "revealChips" && since < 1600 ? "pop" : "";
      const flipCls = g.stage === "revealCards" && since < 2000 ? "flip" : "";
      const delay = (k) => `--fd:${k - since}ms`;
      act = chipEl(pk.chip, popCls, popCls ? delay(s.seat * 90) : "");
      act += cardEl(pk.card, pk.card !== null ? flipCls : "", flipCls ? delay(Math.max(orderIdx, 0) * 130) : "");
      if (orderIdx >= 0) act += `<span class="order-no" title="놓는 순서">${orderIdx + 1}번째</span>`;
      if (g.turn === s.seat) act += `<span class="now">놓는 중</span>`;
      else if (placed.has(s.seat)) act += placed.get(s.seat).passed ? `<span>패스 후 놓음</span>` : `<span>놓음</span>`;
      else if (g.passed.includes(s.seat)) act += `<span>패스</span>`;
    }
    let hand = "";
    if (s.hand && s.seat !== mySeat && g.stage !== "ended") {
      const cards = [0, 1, 2, 3, 4, 5, 6].map((c) => `<span class="${s.hand.cards.includes(c) ? "" : "used"}">${c}</span>`).join("");
      const chips = ["red", "green", "blue", "rainbow"].flatMap((c) => Array(s.hand.chips[c]).fill(`<i class="c-dot-${c}"></i>`)).join("");
      hand = `<div class="mini-hand" title="남은 카드와 칩"><span class="cards">${cards}</span><span class="mini-chips">${chips}</span></div>`;
    }
    const cls = ["plate", s.seat === mySeat ? "me" : "", g.turn === s.seat ? "turn" : ""].join(" ");
    return `
    <div class="${cls}" style="--pc:var(--p${s.color})">
      <div class="plate-top">${badge(s.name, s.color)}<span class="pname">${esc(s.name)}</span>${s.seat === mySeat ? `<span class="tag">나</span>` : ""}${g.first === s.seat && g.stage !== "ended" ? `<span class="first-coin" title="선 플레이어">선</span>` : ""}<i class="dot ${s.online ? "on" : ""}" title="${s.online ? "접속 중" : "접속 끊김"}"></i></div>
      <div class="plate-score"><span class="pts">${s.points}<small>점</small></span>${tally(s.points)}</div>
      <div class="plate-act">${act}</div>
      ${hand}
    </div>`;
  }).join("")}</div>`;
}

function placementLine(g, pl) {
  const name = esc(g.seats[pl.p]?.name);
  const what = `${chipEl(pl.chip)}<b>${name}</b> ${KO[pl.stand]}에 ${pl.card}`;
  if (pl.cleared > 0) return `<li>${what} <span class="pen">${pl.sum}이 되어 벌점 +${pl.cleared}</span>${pl.passed ? `<span class="note">(패스했던 돌)</span>` : ""}</li>`;
  return `<li>${what} <span class="note">합 ${pl.sum}${pl.passed ? ", 패스했던 돌" : ""}</span></li>`;
}

function roundLogHtml(v) {
  const g = v.game;
  if (!["placing", "roundEnd"].includes(g.stage)) return "";
  const lines = g.placements.map((pl) => placementLine(g, pl));
  const waiting = g.passed.filter((p) => !g.placements.some((x) => x.p === p));
  if (waiting.length) lines.push(`<li class="note">패스: ${waiting.map((p) => esc(g.seats[p].name)).join(", ")} (나중에 패스한 사람부터 놓아요)</li>`);
  if (!lines.length) return "";
  return `<div class="panel"><h3>이번 라운드</h3><ul class="log">${lines.join("")}</ul></div>`;
}

function historyHtml(v, open) {
  const g = v.game;
  if (!g.history.length || !open) return "";
  const head = g.seats.map((s) => `<th>${badge(s.name, s.color)} ${esc(s.name)}</th>`).join("");
  const autoSet = new Set((g.auto?.submits || []).map((a) => `${a.round}-${a.seat}`));
  const rows = g.history.map((r) => {
    const cells = g.seats.map((s) => {
      const pk = r.picks[s.seat];
      const pl = r.placements.find((x) => x.p === s.seat);
      return `<td>${chipEl(pk.chip)} ${pk.card}${pk.chip === "rainbow" && pl ? ` <span class="muted">${KO[pl.stand]}</span>` : ""}${r.passes.includes(s.seat) ? ` <span class="muted">패스</span>` : ""}${pl && pl.cleared ? ` <span class="pen">+${pl.cleared}</span>` : ""}${autoSet.has(`${r.round}-${s.seat}`) ? ` <span class="muted">자동</span>` : ""}</td>`;
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
  const sum = rocks.reduce((s, r) => s + r.w, 0) + w;
  if (sum >= LIMIT) return { text: `올리면 ${sum}, 벌점 ${rocks.length}`, danger: true };
  return { text: `올리면 합 ${sum}`, danger: false };
}

function dockHtml(v) {
  const g = v.game;
  const s = v.settings;
  const me = v.me && v.me.seat >= 0 ? v.me : null;
  const total = stageTotalMs(g, s);
  const bar = timerBar(g.until, total);
  const msg = (text) => `<div class="dock-msg">${text}${total ? secsSpan(g.until) : ""}</div>`;
  const nameOf = (seat) => esc(g.seats[seat]?.name);
  let body = "";

  if (g.stage === "submit") {
    const done = g.seats.filter((x) => x.submitted).length;
    const myPick = me ? g.picks[me.seat] : null;
    if (!me) body = msg(`모두 카드를 고르는 중이에요 (${done}/${g.seats.length}명 제출)`);
    else if (myPick) body = msg(`${chipEl(myPick.chip)}${cardEl(myPick.card)} 냈어요. 다른 사람을 기다리는 중 (${done}/${g.seats.length}명)`);
    else {
      const h = g.myHand;
      const sel = S.sel;
      const cards = [0, 1, 2, 3, 4, 5, 6].map((c) => `<button class="card-btn" data-act="pick-card" data-val="${c}" aria-pressed="${sel.card === c}" ${h.cards.includes(c) ? "" : "disabled"} aria-label="카드 ${c}">${c}</button>`).join("");
      const chips = ["red", "green", "blue", "rainbow"].map((c) => `<button class="chip-btn" data-act="pick-chip" data-val="${c}" aria-pressed="${sel.chip === c}" ${h.chips[c] > 0 ? "" : "disabled"} aria-label="${KO[c]} 칩 ${h.chips[c]}개">${chipEl(c)}<span class="n">${h.chips[c]}</span></button>`).join("");
      let hint = "카드 1장과 칩 1개를 고르세요";
      if (sel.card !== null && sel.chip && sel.chip !== "rainbow") {
        const now = g.stands[sel.chip].reduce((a, r) => a + r.w, 0);
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
      body = msg(`${chipEl(pk.chip)}${cardEl(pk.card)} ${a.passedRock ? "패스했던 내 돌을 놓아요" : "남은 사람이 나뿐이라 바로 놓아요"}`);
    } else if (a && me) {
      const pk = g.picks[me.seat];
      const stands = a.needStand ? COLORS : [pk.chip];
      const choices = stands.map((c) => {
        const pv = previewText(g, c, pk.card);
        return `<button class="choice s-${c} ${pv.danger ? "danger" : ""}" data-act="place" data-stand="${c}" ${S.busy ? "disabled" : ""}><b>${KO[c]}에 ${pk.card} 놓기</b><span>${pv.text}</span></button>`;
      });
      if (a.canPass) choices.push(`<button class="choice pass" data-act="pass" ${S.busy ? "disabled" : ""}><b>패스</b><span>남은 ${g.queue.length - 1}명이 먼저 놓아요</span></button>`);
      body = `${msg(`<b>내 차례예요.</b> ${chipEl(pk.chip)}${cardEl(pk.card)}`)}<div class="choice-row">${choices.join("")}</div>`;
    } else if (g.turn !== null) {
      const pk = g.picks[g.turn];
      const mine = me && g.passed.includes(me.seat) ? " 내가 패스한 돌은 맨 뒤에 놓여요." : "";
      body = msg(`<b>${nameOf(g.turn)}</b> 차례 ${chipEl(pk.chip)}${cardEl(pk.card)}${mine}`);
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

function gameHtml(v) {
  const spectator = !v.me || v.me.seat < 0;
  return `
    ${topbarHtml(v)}
    ${spectator ? `<p class="spectate">관전 중이에요. 이번 판이 끝나면 방장이 다음 판을 열 때 들어올 수 있어요.</p>` : ""}
    ${S.netError ? `<div class="notice">연결이 불안정해요. 다시 연결하는 중…</div>` : ""}
    ${hostAwayHtml(v)}
    ${platesHtml(v)}
    ${gameStandsHtml(v)}
    ${roundLogHtml(v)}
    ${historyHtml(v, S.showHistory)}`;
}

function resultHtml(v) {
  const g = v.game;
  const rows = g.standings;
  const lastPlace = Math.max(...rows.map((r) => r.place));
  const tieNote = rows.some((r, i) => i > 0 && rows[i - 1].points === r.points && rows[i - 1].place !== r.place);
  const host = v.me?.isHost;
  return `
  <section class="result">
    ${hostAwayHtml(v)}
    <h1 class="title" style="font-size:clamp(48px,12vw,92px)">결과 발표</h1>
    <ol class="ranks">${rows.map((r, i) => {
      const s = g.seats[r.p];
      const top = r.place === 1;
      const bottom = r.place === lastPlace && lastPlace !== 1;
      return `<li class="${top ? "top" : ""} ${bottom ? "bottom" : ""}" style="--rd:${(rows.length - i) * 160}ms">
        <span class="place">${r.place}</span>
        <span class="who">${badge(s.name, s.color)}<b>${esc(s.name)}</b>${v.me && s.id === v.me.id ? `<span class="tag">나</span>` : ""}${bottom ? `<span class="seal">최하위</span>` : ""}</span>
        <span class="pts">${r.points}<small>점</small></span>
      </li>`;
    }).join("")}</ol>
    ${tieNote ? `<p class="muted small" style="margin:0">벌점이 같으면 더 최근에 벌점을 받은 사람이 아래 순위예요.</p>` : ""}
    <div class="row">
      ${host ? `<button class="btn primary" data-act="rematch">한 판 더 하기</button>` : `<span class="muted">방장이 한 판 더 열면 같은 방에서 이어서 해요.</span>`}
      <button class="link" data-act="home">처음 화면으로</button>
    </div>
    ${gameStandsHtml(v)}
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
        <li><b>Upstash for Redis</b>를 이 프로젝트에 연결합니다. 이미 만든 데이터베이스가 있으면 <b>Connect</b>만 누르면 돼요.</li>
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

  // 하단 행동 패널은 따로 그린다: 내용이 같으면 손대지 않아 누르는 순간 버튼이 바뀌지 않게
  const dock = screen === "game" ? dockHtml(v) : "";
  if (dock !== S.dockHtml) {
    S.dockHtml = dock;
    dockRoot.innerHTML = dock;
  }

  // 입력칸이 있는 화면은 처음 한 번만 그리고, 이후엔 바뀌는 부분만 갱신
  if (screen === "home") {
    if (S.screen !== "home") { app.innerHTML = homeHtml(S.homeMessage); S.homeMessage = null; }
    fitDock();
    S.screen = screen;
    return;
  }
  if (screen === "join") {
    if (S.screen !== "join") app.innerHTML = joinHtml(v);
    else document.getElementById("join-players").innerHTML = playersListHtml(v, false);
    fitDock();
    S.screen = screen;
    return;
  }
  const now = Date.now();
  const fxKey = [S.fx.drop && now - S.fx.drop.at < DROP_MS, ...COLORS.map((c) => S.fx.bust[c] && now - S.fx.bust[c].at < BUST_MS)].join();
  const key = JSON.stringify([screen, v && { ...v, serverNow: 0 }, S.showHistory, S.netError, fxKey]);
  if (key !== S.renderKey || S.screen !== screen) {
    S.renderKey = key;
    S.screen = screen;
    app.innerHTML = html;
  }
  fitDock();
  tick();
}

/** 하단 고정 패널 높이만큼 아래 여백을 줘서 받침대가 가려지지 않게 */
function fitDock() {
  const dock = dockRoot.firstElementChild;
  app.style.paddingBottom = dock ? `${dock.offsetHeight + 20}px` : "";
}
window.addEventListener("resize", fitDock);

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
    el.classList.toggle("low", left <= 5);
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
  S.stageKey = null;
  S.noticeId = undefined;
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

document.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("#app [data-act], #dock-root [data-act]");
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
  if (a === "abort") {
    const ok = await confirmBox("게임을 중단할까요?", "지금 판은 기록 없이 끝나고, 모두 같은 방 대기실로 돌아가요. 같은 멤버로 바로 다시 시작할 수 있어요.", "중단하기");
    if (ok) return act({ action: "abort" });
    return;
  }
  if (a === "transfer") {
    const ok = await confirmBox("방장을 넘길까요?", `${btn.dataset.name}님이 게임 시작·중단·설정을 맡게 돼요.`, "넘기기");
    if (ok) return act({ action: "transfer", id: btn.dataset.id });
    return;
  }
  if (a === "claim") return act({ action: "claimHost" });
  if (a === "kick") return act({ action: "kick", id: btn.dataset.id });
  if (a === "set") {
    const key = btn.dataset.key;
    const val = key === "showHands" ? btn.dataset.val === "true" : Number(btn.dataset.val);
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
