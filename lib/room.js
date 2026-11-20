/**
 * 방(로비·좌석·타이머) 관리와 플레이어별 화면 데이터.
 *
 * 서버리스 환경이라 백그라운드 타이머가 없다. 대신 상태에 "다음 일이 일어날 시각(until)"을
 * 적어 두고, 누군가 요청(폴링)할 때마다 advance()로 지난 시각의 일을 차례로 처리한다.
 */
import * as E from "./engine.js";

/** 화면 코드 버전. public/app.js·public/index.html의 값과 같아야 한다 (tests/version.test.js가 확인).
 *  화면(public/)을 고쳐 배포할 때마다 올린다 → 예전 코드로 열려 있던 탭이 스스로 새로고침한다. */
export const APP_VERSION = "2026-11-20.3";

/** 테스트에서만 H13_TIME_SCALE로 시간을 줄인다 (기본 1 = 실제 시간) */
const SCALE = Number(process.env.H13_TIME_SCALE || 1);
export const TIMING = {
  revealChipsMs: 2000 * SCALE,
  revealCardsMs: 2600 * SCALE,
  autoPlaceMs: 2200 * SCALE, // 고를 것 없는 돌(마지막 순서·패스했던 돌)도 1초 폴링에서 보이도록
  roundEndMs: 5500 * SCALE,
};
const secMs = (sec) => sec * 1000 * SCALE;
export const SUBMIT_OPTIONS = [30, 60, 90, 180];
export const TURN_OPTIONS = [10, 20, 30];
export const DEFAULT_SETTINGS = { submitSec: 60, turnSec: 20, showHands: true };
export const ONLINE_MS = 12000;
/** 방장이 이 시간 넘게 접속하지 않으면 다른 사람이 방장을 맡을 수 있다 */
export const HOST_AWAY_MS = Number(process.env.H13_HOST_AWAY_MS) || 30000 * SCALE; // 테스트에서만 H13_HOST_AWAY_MS로 조정

export class RoomError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // I, O 제외
export function randomCode(rand = Math.random) {
  return Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)]).join("");
}
function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function shuffle(list, rand = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function cleanName(raw) {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 10);
  if (!name) throw new RoomError("닉네임을 입력해 주세요");
  return name;
}

function cleanSettings(raw, base = DEFAULT_SETTINGS) {
  const s = { ...base };
  if (raw && SUBMIT_OPTIONS.includes(Number(raw.submitSec))) s.submitSec = Number(raw.submitSec);
  if (raw && TURN_OPTIONS.includes(Number(raw.turnSec))) s.turnSec = Number(raw.turnSec);
  if (raw && typeof raw.showHands === "boolean") s.showHands = raw.showHands;
  return s;
}

function addPlayer(room, name) {
  if (room.players.length >= E.MAX_PLAYERS) throw new RoomError(`방이 가득 찼어요 (최대 ${E.MAX_PLAYERS}명)`);
  if (room.players.some((p) => p.name === name)) throw new RoomError("같은 닉네임이 이미 있어요");
  const used = new Set(room.players.map((p) => p.color));
  const color = [...Array(E.MAX_PLAYERS).keys()].find((c) => !used.has(c));
  const player = { id: randomHex(4), token: randomHex(16), name, color };
  room.players.push(player);
  return player;
}

export function createRoom(code, name, settings, now) {
  const room = {
    v: 1,
    code,
    createdAt: now,
    hostId: null,
    settings: cleanSettings(settings),
    players: [],
    status: "lobby",
    seats: [],
    game: null,
    stage: null,
    until: null,
    auto: null,
    gameNo: 0,
  };
  const host = addPlayer(room, cleanName(name));
  room.hostId = host.id;
  return { room, player: host };
}

export const playerByToken = (room, token) => (token ? room.players.find((p) => p.token === token) || null : null);
const seatOf = (room, id) => room.seats.indexOf(id);

function requireHost(room, me) {
  if (!me || me.id !== room.hostId) throw new RoomError("방장만 할 수 있어요", 403);
}
function requireSeat(room, me) {
  const seat = me ? seatOf(room, me.id) : -1;
  if (room.status !== "playing" || seat < 0) throw new RoomError("게임에 참가 중이 아니에요", 403);
  return seat;
}
function wrap(fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof E.RuleError) throw new RoomError(e.message, 409);
    throw e;
  }
}

function setNotice(room, kind, now, extra = {}) {
  room.notice = { kind, at: now, id: randomHex(3), ...extra };
}

const hostAway = (room, now, presence) => now - (presence[room.hostId] || 0) > HOST_AWAY_MS;

/** 로비·게임 행동. room을 직접 바꾼다(호출자가 복사본을 넘김). 반환: 추가 응답 데이터 */
export function act(room, me, action, body, now, presence = {}) {
  switch (action) {
    case "join": {
      if (me) return {}; // 이미 참가 (재접속)
      if (room.status !== "lobby") throw new RoomError("이미 게임이 시작됐어요. 다음 판에 들어와 주세요", 409);
      const player = addPlayer(room, cleanName(body.name));
      return { token: player.token };
    }
    case "leave": {
      if (!me) return {};
      if (room.status === "playing") throw new RoomError("게임 중에는 나갈 수 없어요. 창을 닫아도 자동으로 진행돼요", 409);
      room.players = room.players.filter((p) => p.id !== me.id);
      if (room.hostId === me.id) room.hostId = room.players[0]?.id ?? null;
      return {};
    }
    case "abort": {
      requireHost(room, me);
      if (room.status !== "playing") throw new RoomError("진행 중인 게임이 없어요", 409);
      const round = room.game.round + 1;
      room.status = "lobby";
      room.game = null;
      room.stage = null;
      room.until = null;
      room.seats = [];
      setNotice(room, "aborted", now, { by: me.name, round });
      return {};
    }
    case "transfer": {
      requireHost(room, me);
      const target = room.players.find((p) => p.id === body.id);
      if (!target) throw new RoomError("그 참가자를 찾을 수 없어요", 404);
      if (target.id === me.id) return {};
      room.hostId = target.id;
      setNotice(room, "host", now, { name: target.name });
      return {};
    }
    case "claimHost": {
      if (!me) throw new RoomError("방에 참가한 사람만 할 수 있어요", 403);
      if (room.hostId === me.id) return {};
      if (!hostAway(room, now, presence)) throw new RoomError("방장이 아직 접속 중이에요", 409);
      room.hostId = me.id;
      setNotice(room, "host", now, { name: me.name });
      return {};
    }
    case "kick": {
      requireHost(room, me);
      if (room.status === "playing") throw new RoomError("게임 중에는 내보낼 수 없어요", 409);
      if (body.id === me.id) throw new RoomError("자기 자신은 내보낼 수 없어요");
      room.players = room.players.filter((p) => p.id !== body.id);
      return {};
    }
    case "settings": {
      requireHost(room, me);
      if (room.status === "playing") throw new RoomError("게임 중에는 바꿀 수 없어요", 409);
      room.settings = cleanSettings(body.settings, room.settings);
      return {};
    }
    case "start": {
      requireHost(room, me);
      if (room.status === "playing") throw new RoomError("이미 시작했어요", 409);
      if (room.players.length < E.MIN_PLAYERS) throw new RoomError(`최소 ${E.MIN_PLAYERS}명이 필요해요`);
      room.seats = shuffle(room.players.map((p) => p.id)); // 자리 무작위, 0번 자리가 첫 선
      room.notice = null;
      room.game = E.newGame(room.seats.length, 0);
      room.status = "playing";
      room.gameNo += 1;
      room.auto = { submits: [], places: [] };
      room.stage = "submit";
      room.until = now + secMs(room.settings.submitSec);
      return {};
    }
    case "submit": {
      const seat = requireSeat(room, me);
      if (room.stage !== "submit") throw new RoomError("지금은 제출할 수 없어요", 409);
      room.game = wrap(() => E.submit(room.game, seat, Number(body.card), String(body.chip)));
      if (E.allSubmitted(room.game)) beginReveal(room, now);
      return {};
    }
    case "place":
    case "pass": {
      const seat = requireSeat(room, me);
      if (room.stage !== "placing") throw new RoomError("지금은 놓을 수 없어요", 409);
      const asked = E.askedOf(room.game);
      if (!asked || asked.player !== seat) throw new RoomError("내 차례가 아니에요", 409);
      if (action === "pass") room.game = wrap(() => E.pass(room.game, seat));
      else room.game = wrap(() => E.place(room.game, seat, body.stand));
      afterPlacement(room, now);
      return {};
    }
    case "rematch": {
      requireHost(room, me);
      if (room.status !== "ended") throw new RoomError("게임이 끝난 뒤에 할 수 있어요", 409);
      room.status = "lobby";
      room.game = null;
      room.stage = null;
      room.until = null;
      room.seats = [];
      return {};
    }
    default:
      throw new RoomError("알 수 없는 요청이에요");
  }
}

function beginReveal(room, at) {
  room.game = E.beginPlacing(room.game);
  room.stage = "revealChips";
  room.until = at + TIMING.revealChipsMs;
}

/** 놓기 차례의 마감 시각: 물어볼 게 있으면 turnSec, 없으면 짧은 연출 시간 */
function scheduleTurn(room, at) {
  const asked = E.askedOf(room.game);
  const needsHuman = asked && (asked.canPass || asked.needStand);
  room.until = at + (needsHuman ? secMs(room.settings.turnSec) : TIMING.autoPlaceMs);
}

function afterPlacement(room, at) {
  if (room.game.phase === "roundEnd") {
    room.stage = "roundEnd";
    room.until = at + TIMING.roundEndMs;
  } else {
    scheduleTurn(room, at);
  }
}

/** 지난 마감 시각의 일을 모두 처리. 바뀌었으면 true */
export function advance(room, now, rand = Math.random) {
  if (room.status !== "playing") return false;
  let changed = false;
  for (let guard = 0; guard < 500 && room.until !== null && now >= room.until; guard++) {
    const at = room.until;
    changed = true;
    switch (room.stage) {
      case "submit": {
        for (let p = 0; p < room.game.n; p++) {
          if (room.game.picks[p]) continue;
          const pick = E.autoPick(room.game, p, rand);
          room.game = E.submit(room.game, p, pick.card, pick.chip);
          room.auto.submits.push({ round: room.game.round, seat: p });
        }
        beginReveal(room, at);
        break;
      }
      case "revealChips":
        room.stage = "revealCards";
        room.until = at + TIMING.revealCardsMs;
        break;
      case "revealCards":
        room.stage = "placing";
        scheduleTurn(room, at);
        break;
      case "placing": {
        const asked = E.askedOf(room.game);
        const p = asked.player;
        const pick = room.game.picks[p];
        const stand = pick.chip === "rainbow" ? E.safestStand(room.game, pick.card) : undefined;
        if (asked.canPass || asked.needStand) room.auto.places.push({ round: room.game.round, seat: p, why: "timeout" });
        room.game = E.place(room.game, p, stand);
        afterPlacement(room, at);
        break;
      }
      case "roundEnd": {
        room.game = E.nextRound(room.game);
        if (room.game.phase === "ended") {
          room.stage = "ended";
          room.status = "ended";
          room.until = null;
        } else {
          room.stage = "submit";
          room.until = at + secMs(room.settings.submitSec);
        }
        break;
      }
      default:
        room.until = null;
    }
  }
  return changed;
}

const STAGE_RANK = { submit: 0, revealChips: 1, revealCards: 2, placing: 3, roundEnd: 4, ended: 5 };

/** 공개해도 되는 남은 패: 아직 공개 전인 이번 라운드 제출은 되돌려서 보여 준다 */
function publicHand(room, seat) {
  const g = room.game;
  const hand = E.remainingOf(g, seat);
  const pick = g.picks[seat];
  const rank = STAGE_RANK[room.stage] ?? 0;
  if (pick) {
    if (rank < 1) hand.chips[pick.chip] += 1;
    if (rank < 2) hand.cards = [...hand.cards, pick.card].sort((a, b) => a - b);
  }
  return hand;
}

/** 플레이어별 화면 데이터. 남의 비공개 정보는 절대 넣지 않는다. */
export function viewFor(room, me, now, presence = {}) {
  const online = (id) => now - (presence[id] || 0) < ONLINE_MS;
  const base = {
    serverNow: now,
    appVersion: APP_VERSION,
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    settings: room.settings,
    me: me ? { id: me.id, name: me.name, isHost: me.id === room.hostId, seat: room.seats.indexOf(me.id) } : null,
    players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color, online: online(p.id) })),
    hostAway: room.hostId ? hostAway(room, now, presence) : false,
    notice: room.notice || null,
    game: null,
  };
  const g = room.game;
  if (!g || room.status === "lobby") return base;

  const rank = STAGE_RANK[room.stage] ?? 0;
  const mySeat = base.me ? base.me.seat : -1;
  const byId = Object.fromEntries(room.players.map((p) => [p.id, p]));
  const asked = room.stage === "placing" ? E.askedOf(g) : null;
  const round = g.phase === "ended" ? E.ROUNDS - 1 : g.round;

  const picks = g.picks.map((pk, s) => {
    if (!pk) return null;
    if (s === mySeat) return { chip: pk.chip, card: pk.card };
    if (rank < 1) return null;
    return { chip: pk.chip, card: rank >= 2 ? pk.card : null };
  });

  base.game = {
    gameNo: room.gameNo,
    stage: room.stage,
    until: room.until,
    round,
    rounds: E.ROUNDS,
    perSet: E.ROUNDS_PER_SET,
    first: g.first,
    seats: room.seats.map((id, s) => {
      const p = byId[id] || { name: "?", color: 0 };
      return {
        seat: s,
        id,
        name: p.name,
        color: p.color,
        online: online(id),
        submitted: Boolean(g.picks[s]),
        points: g.penalties[s].points,
        last: g.penalties[s].last,
        hand: room.settings.showHands || s === mySeat ? publicHand(room, s) : null,
      };
    }),
    stands: Object.fromEntries(E.COLORS.map((c) => [c, g.stands[c].map((r) => ({ seat: r.p, w: r.w }))])),
    picks,
    order: rank >= 2 ? g.order : [],
    queue: rank >= 3 ? g.queue : [],
    passed: rank >= 3 ? g.passed : [],
    turn: asked ? asked.player : null,
    asked: asked && asked.player === mySeat ? asked : null,
    placements: rank >= 3 ? g.placements : [],
    myHand: mySeat >= 0 ? E.remainingOf(g, mySeat) : null,
    history: g.history,
    auto: room.auto,
    standings: E.standings(g),
  };
  return base;
}
