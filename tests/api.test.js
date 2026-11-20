/**
 * API 통합 테스트: 실제 HTTP 서버를 띄우고 가상 플레이어들이 끝까지 대전한다.
 *  - 4인 완주 (사람처럼 랜덤 합법 행동 + 일부는 시간 초과로 자동 처리)
 *  - 제출 단계에서 남의 카드·칩이 응답 어디에도 없는지 (정보 유출 검사)
 *  - 동시 제출 경합(CAS) 상황에서도 제출이 하나도 사라지지 않는지
 * 저장소는 H13_STORE=redis면 실제 Redis(Upstash REST 호환 shim), 아니면 메모리.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.H13_TIME_SCALE = process.env.H13_TIME_SCALE || "0.01";

const { createServer } = await import("../dev-server.js");
const { getStore } = await import("../lib/store.js");

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api/room`;
});
after(() => server.close());

async function post(body) {
  const res = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  return { ...json, http: res.status };
}
async function get(code, token, beat) {
  const q = new URLSearchParams({ code, token: token || "" });
  if (beat) q.set("beat", beat);
  const res = await fetch(`${base}?${q}`);
  return { ...(await res.json()), http: res.status };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeRoom(names, settings) {
  const created = await post({ action: "create", name: names[0], settings });
  assert.equal(created.http, 200, created.error);
  const players = [{ name: names[0], token: created.token, id: created.view.me.id }];
  for (const name of names.slice(1)) {
    const j = await post({ action: "join", code: created.code, name });
    assert.equal(j.http, 200, j.error);
    players.push({ name, token: j.token, id: j.view.me.id });
  }
  return { code: created.code, players };
}

test(`저장소 종류: ${getStore().kind}`, () => assert.ok(getStore()));

test("로비 규칙: 닉네임 중복·8명 초과·방장 외 시작 거부", async () => {
  const { code, players } = await makeRoom(["가", "나"]);
  assert.equal((await post({ action: "join", code, name: "가" })).http, 400);
  assert.equal((await post({ action: "start", code, token: players[1].token })).http, 403);
  for (const n of ["다", "라", "마", "바", "사"]) assert.equal((await post({ action: "join", code, name: n })).http, 200);
  assert.equal((await post({ action: "join", code, name: "아" })).http, 400);
  assert.equal((await get("ZZZZ", "")).http, 404);
});

test("4인 완주 + 정보 유출 없음 + 순위 계산", { timeout: 120000 }, async () => {
  const { code, players } = await makeRoom(["강", "김", "이", "박"]);
  const start = await post({ action: "start", code, token: players[0].token });
  assert.equal(start.http, 200, start.error);

  let rounds = new Set();
  let leakChecks = 0;
  let lazy = players[3]; // 이 사람은 3라운드마다 아무것도 안 해서 시간 초과 자동 처리를 받는다
  for (let tick = 0; tick < 5000; tick++) {
    const views = await Promise.all(players.map((p) => get(code, p.token, p.id)));
    const v0 = views[0];
    assert.equal(v0.http, 200, v0.error);
    if (v0.http !== 200) break;
    if (v0.game) rounds.add(v0.game.round);
    if (v0.game.stage === "ended") break;

    for (let i = 0; i < players.length; i++) {
      const v = views[i];
      const g = v.game;
      const mySeat = v.me.seat;
      // 유출 검사: 제출 단계에서는 내 것 외에 picks가 없어야 하고, 남의 공개 패는 제출 전 상태여야 한다
      if (g.stage === "submit") {
        g.picks.forEach((pk, s) => { if (s !== mySeat) assert.equal(pk, null, "남의 제출이 보임"); });
        g.seats.forEach((st, s) => {
          if (s !== mySeat && st.submitted) {
            const cardCount = st.hand.cards.length;
            const chipCount = Object.values(st.hand.chips).reduce((a, b) => a + b, 0);
            assert.equal(cardCount, chipCount, "남의 남은 패에서 이번 제출이 빠져 보임");
          }
        });
        const raw = JSON.stringify(v);
        players.forEach((p) => { if (p !== players[i]) assert.ok(!raw.includes(p.token), "남의 토큰이 응답에 있음"); });
        leakChecks++;
      }
      if (g.stage === "revealChips") g.picks.forEach((pk, s) => { if (s !== mySeat && pk) assert.equal(pk.card, null, "칩 공개 단계에 카드가 보임"); });

      const isLazy = players[i] === lazy && g.round % 3 === 2;
      if (isLazy) continue;
      if (g.stage === "submit" && !g.picks[mySeat]) {
        const h = g.myHand;
        const chips = Object.entries(h.chips).flatMap(([k, n]) => Array(n).fill(k));
        const card = h.cards[Math.floor(Math.random() * h.cards.length)];
        const chip = chips[Math.floor(Math.random() * chips.length)];
        const r = await post({ action: "submit", code, token: players[i].token, card, chip });
        assert.ok([200, 409].includes(r.http), r.error);
      }
      if (g.stage === "placing" && g.asked) {
        const a = g.asked;
        const stands = ["red", "green", "blue"];
        const body = a.canPass && Math.random() < 0.3
          ? { action: "pass" }
          : { action: "place", stand: a.needStand ? stands[Math.floor(Math.random() * 3)] : undefined };
        const r = await post({ ...body, code, token: players[i].token });
        assert.ok([200, 409].includes(r.http), r.error);
      }
    }
    await sleep(5);
  }

  const end = await get(code, players[0].token);
  assert.equal(end.game.stage, "ended", "게임이 끝나지 않음");
  assert.equal(end.status, "ended");
  assert.equal(end.game.history.length, 14, "14라운드 기록");
  assert.equal(rounds.size, 14);
  assert.ok(leakChecks > 20);
  // 모든 사람이 카드 0~6을 세트마다 한 번씩 썼는지
  for (let s = 0; s < 4; s++) {
    for (const set of [end.game.history.slice(0, 7), end.game.history.slice(7)]) {
      assert.deepEqual(set.map((r) => r.picks[s].card).sort(), [0, 1, 2, 3, 4, 5, 6]);
    }
  }
  // 벌점 합 = 기록에서 다시 계산한 값
  const fromHistory = [0, 0, 0, 0];
  end.game.history.forEach((r) => r.placements.forEach((x) => { fromHistory[x.p] += x.cleared; }));
  assert.deepEqual(end.game.seats.map((s) => s.points), fromHistory);
  assert.ok(end.game.auto.submits.length > 0, "시간 초과 자동 제출이 일어남");
  assert.equal(end.game.standings.length, 4);

  // 다시 하기 → 로비
  const re = await post({ action: "rematch", code, token: players[0].token });
  assert.equal(re.http, 200);
  assert.equal(re.view.status, "lobby");
});

test("동시 제출 경합: 4명이 같은 순간 제출해도 하나도 안 사라짐", async () => {
  for (let trial = 0; trial < 5; trial++) {
    const { code, players } = await makeRoom(["A1", "B2", "C3", "D4"], { submitSec: 180 });
    await post({ action: "start", code, token: players[0].token });
    const results = await Promise.all(players.map((p) => post({ action: "submit", code, token: p.token, card: 3, chip: "red" })));
    results.forEach((r) => assert.equal(r.http, 200, r.error));
    const v = await get(code, players[0].token);
    assert.ok(v.game.seats.every((s) => s.submitted), "제출 누락");
    assert.notEqual(v.game.stage, "submit");
  }
});

test("관전자(토큰 없음)는 아무 제출도 못 보고 행동도 못 함", async () => {
  const { code, players } = await makeRoom(["P", "Q"], { submitSec: 180 });
  await post({ action: "start", code, token: players[0].token });
  await post({ action: "submit", code, token: players[0].token, card: 6, chip: "blue" });
  const spectator = await get(code, "");
  assert.equal(spectator.me, null);
  assert.ok(spectator.game.picks.every((x) => x === null));
  assert.equal((await post({ action: "submit", code, token: "nope", card: 1, chip: "red" })).http, 403);
});
