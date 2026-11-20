/**
 * 무거운 13 — 규칙 엔진 (순수 함수 상태머신)
 *
 * 화면·서버·시간과 무관하게 규칙만 다룬다. 모든 함수는 입력 상태를 바꾸지 않고
 * 새 상태를 돌려준다. 잘못된 행동은 RuleError를 던진다.
 *
 * 규칙 (데블스 플랜: 데드 어게인 1일차 감옥매치 진행 기준)
 *  - 각자 바위 카드 0~6 (7장), 칩 빨강·초록·파랑 각 2개 + 레인보우 1개.
 *  - 14라운드. 7라운드마다 카드·칩 한 세트를 새로 받는다. 받침대는 리셋하지 않는다.
 *  - 라운드마다 카드 1장 + 칩 1개를 동시에 비공개 제출 → 칩 공개 → 카드 공개.
 *  - 놓는 순서: 레인보우 칩 → 카드 숫자 높은 순 → 같으면 선 플레이어부터 시계 방향.
 *    (레인보우끼리도 숫자 높은 순, 같으면 시계 방향)
 *  - 자기 차례에 놓기 / 패스 선택. 패스한 바위는 다른 바위를 다 놓은 뒤
 *    "패스한 순서의 역순"으로 놓는다. 아직 안 놓은 사람이 자기 혼자면 패스 불가.
 *  - 칩 색 = 받침대. 레인보우는 놓는 순간 받침대를 고른다.
 *  - 놓은 뒤 받침대 합이 13 이상(정확히 13 포함)이면 기존 바위를 모두 걷어내고
 *    그 개수만큼 벌점. 방금 놓은 바위는 남는다. 무게 0 바위도 1개로 센다.
 *  - 라운드에서 마지막으로 벌점을 받은 사람이 다음 라운드 선 플레이어.
 *    아무도 안 받으면 그대로.
 *  - 최종: 벌점 적은 순. 같으면 더 일찍(또는 한 번도 안) 받은 사람이 위.
 */

export const LIMIT = 13;
export const CARDS = [0, 1, 2, 3, 4, 5, 6];
export const COLORS = ["red", "green", "blue"];
export const CHIP_KINDS = ["red", "green", "blue", "rainbow"];
export const CHIP_SET = { red: 2, green: 2, blue: 2, rainbow: 1 };
export const ROUNDS_PER_SET = 7;
export const ROUNDS = 14;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 7;

export class RuleError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const clone = (x) => structuredClone(x);
const freshHand = () => ({ cards: [...CARDS], chips: { ...CHIP_SET } });

/** 새 게임. n = 인원(좌석 0..n-1, 시계 방향), first = 1라운드 선 플레이어 좌석. */
export function newGame(n, first = 0) {
  if (!Number.isInteger(n) || n < MIN_PLAYERS || n > MAX_PLAYERS) {
    throw new RuleError("bad-players", `인원은 ${MIN_PLAYERS}~${MAX_PLAYERS}명이어야 합니다`);
  }
  if (!Number.isInteger(first) || first < 0 || first >= n) throw new RuleError("bad-first");
  return {
    n,
    round: 0, // 0-based
    phase: "submit", // submit | placing | roundEnd | ended
    first,
    hands: Array.from({ length: n }, freshHand),
    stands: { red: [], green: [], blue: [] },
    penalties: Array.from({ length: n }, () => ({ points: 0, last: 0 })),
    taken: 0, // 벌점이 나올 때마다 1씩 증가 (최근성 비교용)
    picks: Array(n).fill(null),
    order: [],
    queue: [],
    passed: [],
    placements: [],
    history: [],
  };
}

export const standSum = (stand) => stand.reduce((s, r) => s + r.w, 0);

/** 시계 방향 거리 (선 플레이어 = 0) */
const dist = (state, p) => (p - state.first + state.n) % state.n;

/** 제출 */
export function submit(state, p, card, chip) {
  if (state.phase !== "submit") throw new RuleError("not-submit-phase", "지금은 제출 단계가 아닙니다");
  if (!(p >= 0 && p < state.n)) throw new RuleError("bad-player");
  if (state.picks[p]) throw new RuleError("already-submitted", "이미 제출했습니다");
  const hand = state.hands[p];
  if (!hand.cards.includes(card)) throw new RuleError("no-card", "가지고 있지 않은 카드입니다");
  if (!CHIP_KINDS.includes(chip) || !(hand.chips[chip] > 0)) throw new RuleError("no-chip", "가지고 있지 않은 칩입니다");
  const next = clone(state);
  next.picks[p] = { card, chip };
  next.hands[p].cards = hand.cards.filter((c) => c !== card);
  next.hands[p].chips[chip] -= 1;
  return next;
}

export const allSubmitted = (state) => state.picks.every(Boolean);

/** 공개 후 놓는 순서 계산 */
export function orderOf(state) {
  const players = [...Array(state.n).keys()];
  return players.sort((a, b) => {
    const pa = state.picks[a];
    const pb = state.picks[b];
    const ra = pa.chip === "rainbow" ? 0 : 1;
    const rb = pb.chip === "rainbow" ? 0 : 1;
    if (ra !== rb) return ra - rb;
    if (pa.card !== pb.card) return pb.card - pa.card;
    return dist(state, a) - dist(state, b);
  });
}

/** 전원 제출 → 놓기 단계 시작 */
export function beginPlacing(state) {
  if (state.phase !== "submit") throw new RuleError("not-submit-phase");
  if (!allSubmitted(state)) throw new RuleError("not-all-submitted", "아직 제출하지 않은 사람이 있습니다");
  const next = clone(state);
  next.order = orderOf(next);
  next.queue = [...next.order];
  next.passed = [];
  next.placements = [];
  next.phase = "placing";
  return next;
}

/** 지금 바위를 놓을 차례인 사람 (없으면 null) */
export function turnOf(state) {
  if (state.phase !== "placing") return null;
  if (state.queue.length) return state.queue[0];
  if (state.passed.length) return state.passed[state.passed.length - 1];
  return null;
}

/** 차례인 사람에게 무엇을 묻는가: { canPass, needStand } */
export function askedOf(state) {
  const p = turnOf(state);
  if (p === null) return null;
  const fromQueue = state.queue.length > 0;
  return {
    player: p,
    canPass: fromQueue && state.queue.length > 1,
    needStand: state.picks[p].chip === "rainbow",
    passedRock: !fromQueue,
  };
}

/** 이 바위를 이 받침대에 놓으면 생길 결과 (미리보기) */
export function preview(state, stand, w) {
  const s = state.stands[stand];
  const sum = standSum(s) + w;
  return sum >= LIMIT ? { sum, bust: true, cleared: s.length, after: w } : { sum, bust: false, cleared: 0, after: sum };
}

/** 놓기. 레인보우면 stand 필수, 일반 칩이면 stand 무시(칩 색). */
export function place(state, p, stand) {
  const asked = askedOf(state);
  if (!asked) throw new RuleError("not-placing", "지금은 놓는 단계가 아닙니다");
  if (asked.player !== p) throw new RuleError("not-your-turn", "차례가 아닙니다");
  const pick = state.picks[p];
  let target = pick.chip;
  if (pick.chip === "rainbow") {
    if (!COLORS.includes(stand)) throw new RuleError("need-stand", "레인보우 칩은 받침대를 골라야 합니다");
    target = stand;
  }
  const next = clone(state);
  if (asked.passedRock) next.passed.pop();
  else next.queue.shift();

  const s = next.stands[target];
  const sumBefore = standSum(s);
  const sum = sumBefore + pick.card;
  let cleared = 0;
  let clearedRocks = [];
  if (sum >= LIMIT) {
    cleared = s.length;
    clearedRocks = s.map((r) => ({ p: r.p, w: r.w }));
    next.taken += 1;
    next.penalties[p].points += cleared;
    next.penalties[p].last = next.taken;
    next.stands[target] = [{ p, w: pick.card }];
  } else {
    s.push({ p, w: pick.card });
  }
  next.placements.push({ p, card: pick.card, chip: pick.chip, stand: target, sumBefore, sum, cleared, clearedRocks, passed: asked.passedRock });
  if (turnOf(next) === null) endRound(next);
  return next;
}

/** 패스 */
export function pass(state, p) {
  const asked = askedOf(state);
  if (!asked) throw new RuleError("not-placing", "지금은 놓는 단계가 아닙니다");
  if (asked.player !== p) throw new RuleError("not-your-turn", "차례가 아닙니다");
  if (!asked.canPass) throw new RuleError("cannot-pass", "지금은 패스할 수 없습니다");
  const next = clone(state);
  next.queue.shift();
  next.passed.push(p);
  return next;
}

/** (내부) 라운드 종료 처리: 선 플레이어 이동, 기록 */
function endRound(next) {
  const firstBefore = next.first;
  const lastPen = [...next.placements].reverse().find((x) => x.cleared > 0);
  if (lastPen) next.first = lastPen.p;
  next.history.push({
    round: next.round,
    first: firstBefore,
    picks: clone(next.picks),
    order: [...next.order],
    passes: next.placements.filter((x) => x.passed).map((x) => x.p).reverse(),
    placements: clone(next.placements),
    nextFirst: next.first,
  });
  next.phase = "roundEnd";
}

/** 다음 라운드로 (14라운드 끝나면 ended) */
export function nextRound(state) {
  if (state.phase !== "roundEnd") throw new RuleError("not-round-end");
  const next = clone(state);
  next.round += 1;
  next.picks = Array(next.n).fill(null);
  next.order = [];
  next.queue = [];
  next.passed = [];
  next.placements = [];
  if (next.round >= ROUNDS) {
    next.phase = "ended";
    return next;
  }
  if (next.round % ROUNDS_PER_SET === 0) next.hands = Array.from({ length: next.n }, freshHand);
  next.phase = "submit";
  return next;
}

/** 최종(또는 현재) 순위. 벌점 적은 순, 동점이면 더 일찍 받은(=last 작은) 사람이 위. 완전 동률은 같은 등수. */
export function standings(state) {
  const rows = state.penalties.map((x, p) => ({ p, points: x.points, last: x.last }));
  rows.sort((a, b) => a.points - b.points || a.last - b.last || a.p - b.p);
  let place = 0;
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    if (!prev || prev.points !== r.points || prev.last !== r.last) place = i + 1;
    r.place = place;
  });
  return rows;
}

/** 시간 초과 시 자동 제출: 남은 카드·칩 중 무작위 */
export function autoPick(state, p, rand = Math.random) {
  const hand = state.hands[p];
  const card = hand.cards[Math.floor(rand() * hand.cards.length)];
  const chips = CHIP_KINDS.flatMap((k) => Array(hand.chips[k]).fill(k));
  const chip = chips[Math.floor(rand() * chips.length)];
  return { card, chip };
}

/** 시간 초과/자동 처리 시 레인보우 받침대 선택: 벌점 없는 곳 중 합이 가장 작은 곳, 없으면 벌점 가장 적은 곳 */
export function safestStand(state, w) {
  const options = COLORS.map((c) => ({ c, ...preview(state, c, w) }));
  options.sort((a, b) => a.cleared - b.cleared || a.after - b.after);
  return options[0].c;
}

/** 다른 사람의 남은 패 (공개된 기록에서 추론 가능한 정보) */
export function remainingOf(state, p) {
  return { cards: [...state.hands[p].cards], chips: { ...state.hands[p].chips } };
}
