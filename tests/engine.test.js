import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  newGame, submit, beginPlacing, place, pass, nextRound, turnOf, askedOf,
  standings, orderOf, standSum, autoPick, safestStand, RuleError, ROUNDS,
} from "../lib/engine.js";
import { MATCH, TOTALS } from "./fixtures/broadcast-match.js";

/** 모든 사람 제출 후 놓기 단계로 */
function play(state, picks) {
  picks.forEach(([card, chip], p) => { state = submit(state, p, card, chip); });
  return beginPlacing(state);
}

describe("규칙 엔진 — 기본", () => {
  test("시작 상태: 카드 0~6, 칩 빨2·초2·파2·레1", () => {
    const g = newGame(4);
    assert.equal(g.hands.length, 4);
    assert.deepEqual(g.hands[0].cards, [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(g.hands[0].chips, { red: 2, green: 2, blue: 2, rainbow: 1 });
    assert.equal(g.phase, "submit");
  });

  test("인원 제한 2~7", () => {
    assert.throws(() => newGame(1), RuleError);
    assert.throws(() => newGame(8), RuleError);
  });

  test("없는 카드·칩, 중복 제출은 거부", () => {
    let g = newGame(3);
    g = submit(g, 0, 3, "red");
    assert.throws(() => submit(g, 0, 4, "red"), /이미 제출/);
    assert.throws(() => submit(g, 1, 9, "red"), /카드/);
    assert.throws(() => submit(g, 1, 2, "purple"), /칩/);
  });

  test("제출해도 원본 상태는 바뀌지 않는다 (순수 함수)", () => {
    const g = newGame(3);
    submit(g, 0, 3, "red");
    assert.equal(g.picks[0], null);
    assert.equal(g.hands[0].cards.length, 7);
  });

  test("순서: 레인보우 → 큰 숫자 → 선부터 시계 방향", () => {
    let g = newGame(4, 2);
    g = play(g, [[5, "red"], [6, "green"], [5, "blue"], [1, "rainbow"]]);
    // 레인보우(3) 먼저, 6(1), 5는 선(2)부터 시계: 2 → 0
    assert.deepEqual(g.order, [3, 1, 2, 0]);
  });

  test("정확히 13이면 걷어내고 기존 바위 개수만큼 벌점, 내 바위는 남는다", () => {
    let g = newGame(3);
    g = play(g, [[6, "red"], [4, "red"], [3, "red"]]); // 6 → 10 → 13
    g = place(g, 0); g = place(g, 1); g = place(g, 2);
    assert.equal(g.penalties[2].points, 2);
    assert.deepEqual(g.stands.red, [{ p: 2, w: 3 }]);
    assert.equal(g.first, 2, "마지막 벌점자가 다음 선");
  });

  test("12까지는 안전", () => {
    let g = newGame(3);
    g = play(g, [[6, "red"], [4, "red"], [2, "red"]]);
    g = place(g, 0); g = place(g, 1); g = place(g, 2);
    assert.equal(standSum(g.stands.red), 12);
    assert.equal(g.penalties.reduce((s, x) => s + x.points, 0), 0);
    assert.equal(g.first, 0, "벌점 없으면 선 유지");
  });

  test("무게 0 바위도 개수에 들어간다", () => {
    let g = newGame(4);
    g = play(g, [[6, "blue"], [6, "blue"], [0, "blue"], [1, "blue"]]);
    // 6 → 12, 0 → 12, 1 → 13 → 3개 걷어냄
    assert.deepEqual(g.order, [0, 1, 3, 2]);
    g = place(g, 0); g = place(g, 1); g = place(g, 3);
    assert.equal(g.penalties[3].points, 2);
    g = place(g, 2);
    assert.equal(standSum(g.stands.blue), 1);
    assert.equal(g.stands.blue.length, 2);
  });

  test("패스: 패스한 바위는 맨 뒤, 먼저 패스한 사람이 가장 늦게", () => {
    let g = newGame(4);
    g = play(g, [[6, "red"], [5, "green"], [4, "blue"], [3, "red"]]);
    g = pass(g, 0);
    g = pass(g, 1);
    assert.equal(askedOf(g).canPass, true);
    g = place(g, 2);
    assert.equal(turnOf(g), 3);
    assert.equal(askedOf(g).canPass, false, "남은 사람이 혼자면 패스 불가");
    assert.throws(() => pass(g, 3), /패스할 수 없/);
    g = place(g, 3);
    assert.equal(turnOf(g), 1, "나중에 패스한 1이 먼저");
    assert.equal(askedOf(g).canPass, false, "패스한 바위는 다시 묻지 않음");
    g = place(g, 1);
    assert.equal(turnOf(g), 0);
    g = place(g, 0);
    assert.equal(g.phase, "roundEnd");
    assert.deepEqual(g.history[0].passes, [0, 1]);
  });

  test("레인보우는 받침대를 골라야 하고, 패스한 레인보우도 놓을 때 고른다", () => {
    let g = newGame(3);
    g = play(g, [[2, "rainbow"], [5, "red"], [1, "green"]]);
    assert.equal(askedOf(g).needStand, true);
    assert.throws(() => place(g, 0), /받침대/);
    g = pass(g, 0);
    g = place(g, 1); g = place(g, 2);
    assert.equal(turnOf(g), 0);
    assert.deepEqual(askedOf(g), { player: 0, canPass: false, needStand: true, passedRock: true });
    g = place(g, 0, "blue");
    assert.deepEqual(g.stands.blue, [{ p: 0, w: 2 }]);
  });

  test("차례가 아닌 사람은 놓을 수 없다", () => {
    let g = newGame(3);
    g = play(g, [[6, "red"], [5, "red"], [4, "red"]]);
    assert.throws(() => place(g, 2), /차례/);
  });

  test("7라운드 뒤 카드·칩 새로 지급, 받침대는 그대로", () => {
    let g = newGame(2);
    for (let r = 0; r < 7; r++) {
      const picks = [0, 1].map((p) => [g.hands[p].cards[0], ["red", "red", "green", "green", "blue", "blue", "rainbow"][r]]);
      g = play(g, picks);
      while (turnOf(g) !== null) g = place(g, turnOf(g), "green");
      g = nextRound(g);
    }
    assert.equal(g.round, 7);
    assert.equal(g.hands[0].cards.length, 7);
    assert.equal(g.hands[0].chips.rainbow, 1);
    const total = ["red", "green", "blue"].reduce((s, c) => s + g.stands[c].length, 0);
    assert.ok(total > 0, "받침대 유지");
  });

  test("순위: 벌점 적은 순, 동점이면 최근에 받은 사람이 아래", () => {
    const g = newGame(3);
    g.penalties = [{ points: 5, last: 4 }, { points: 5, last: 2 }, { points: 1, last: 1 }];
    const s = standings(g);
    assert.deepEqual(s.map((x) => x.p), [2, 1, 0]);
    assert.deepEqual(s.map((x) => x.place), [1, 2, 3]);
  });

  test("한 번도 안 받은 사람끼리는 공동 순위", () => {
    const g = newGame(3);
    const s = standings(g);
    assert.deepEqual(s.map((x) => x.place), [1, 1, 1]);
  });

  test("자동 처리: 남은 패 안에서 고르고, 레인보우는 안전한 받침대", () => {
    let g = newGame(2);
    g = submit(g, 0, 3, "rainbow");
    const pick = autoPick(g, 0);
    assert.ok(g.hands[0].cards.includes(pick.card));
    assert.notEqual(pick.chip, "rainbow");
    g.stands = { red: [{ p: 0, w: 6 }, { p: 1, w: 6 }], green: [{ p: 0, w: 5 }], blue: [{ p: 0, w: 1 }] };
    assert.equal(safestStand(g, 4), "blue");
  });
});

describe("방송 판 재생 (7인 14라운드) — 외부 검증", () => {
  function replay() {
    let g = newGame(7, MATCH[0].first);
    const rounds = [];
    for (const r of MATCH) {
      const first = g.first;
      g = play(g, r.picks.map(([c, ch]) => [c, ch]));
      const order = [...g.order];
      const passes = [];
      while (turnOf(g) !== null) {
        const a = askedOf(g);
        if (a.canPass && r.passes.includes(a.player) && !passes.includes(a.player)) {
          passes.push(a.player);
          g = pass(g, a.player);
        } else {
          g = place(g, a.player, r.picks[a.player][2]);
        }
      }
      const penalties = g.placements.filter((x) => x.cleared > 0).map((x) => [x.p, x.cleared]);
      rounds.push({ first, order, passes, penalties });
      g = nextRound(g);
    }
    return { rounds, g };
  }

  test("라운드별 선 플레이어가 방송과 같다", () => {
    assert.deepEqual(replay().rounds.map((r) => r.first), MATCH.map((r) => r.first));
  });
  test("라운드별 호명 순서가 방송과 같다", () => {
    assert.deepEqual(replay().rounds.map((r) => r.order), MATCH.map((r) => r.order));
  });
  test("패스가 모두 규칙상 허용되고 방송과 같다", () => {
    assert.deepEqual(replay().rounds.map((r) => r.passes), MATCH.map((r) => r.passes));
  });
  test("벌점을 받은 사람·점수·순서가 방송과 같다", () => {
    assert.deepEqual(replay().rounds.map((r) => r.penalties), MATCH.map((r) => r.penalties));
  });
  test(`최종 벌점이 방송과 같다 (${[...TOTALS].sort((a, b) => a - b).join("·")})`, () => {
    const { g } = replay();
    assert.equal(g.phase, "ended");
    assert.equal(g.round, ROUNDS);
    assert.deepEqual(g.penalties.map((x) => x.points), TOTALS);
  });
  test("최종 순위: 11점 동점자 중 나중에 받은 사람이 아래 (6·7위 = 탈락권)", () => {
    const s = standings(replay().g);
    assert.deepEqual(s.map((x) => x.p), [5, 1, 6, 4, 3, 2, 0]);
    assert.deepEqual(s.map((x) => x.place), [1, 2, 3, 4, 5, 6, 7]);
  });
});
