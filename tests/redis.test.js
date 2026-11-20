/**
 * 실제 Redis 검증: redis-server를 띄우고 Upstash REST 형식 shim을 거쳐
 * CAS(Lua EVAL)·파이프라인·TTL이 실제로 동작하는지 확인한다.
 * redis-server가 없는 환경에서는 건너뛴다.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { UpstashStore } from "../lib/store.js";
import { startShim } from "./support/upstash-shim.js";

const hasRedis = spawnSync("which", ["redis-server"]).status === 0;
let redis, shim, store;
const PORT = 6390 + Math.floor(Math.random() * 50);

before(async () => {
  if (!hasRedis) return;
  redis = spawn("redis-server", ["--port", String(PORT), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    if (spawnSync("redis-cli", ["-p", String(PORT), "ping"]).stdout?.toString().includes("PONG")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  shim = await startShim(PORT, "test-token");
  store = new UpstashStore({ url: shim.url, token: "test-token" });
});
after(() => {
  shim?.server.close();
  shim?.client.close();
  redis?.kill();
});

test("CAS: 없는 방은 ver 0으로만 생성, 버전이 맞을 때만 교체", { skip: !hasRedis }, async () => {
  assert.equal(await store.cas("TEST", "0", "1", { a: 1 }), true);
  assert.equal(await store.cas("TEST", "0", "1", { a: 2 }), false, "이미 있으면 생성 실패");
  assert.equal(await store.cas("TEST", "1", "2", { a: 3 }), true);
  assert.equal(await store.cas("TEST", "1", "2", { a: 4 }), false, "옛 버전으로는 못 바꿈");
  const { ver, room } = await store.load("TEST");
  assert.equal(ver, "2");
  assert.deepEqual(room, { a: 3 });
});

test("동시 CAS 20건 중 정확히 1건만 성공", { skip: !hasRedis }, async () => {
  await store.cas("RACE", "0", "1", { n: 0 });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.cas("RACE", "1", "2", { n: i })));
  assert.equal(results.filter(Boolean).length, 1);
});

test("TTL이 걸리고 접속 표시가 파이프라인으로 함께 기록됨", { skip: !hasRedis }, async () => {
  await store.cas("TTLX", "0", "1", { x: 1 });
  const ttl = Number(spawnSync("redis-cli", ["-p", String(PORT), "TTL", "h13:room:TTLX"]).stdout.toString());
  assert.ok(ttl > 40000 && ttl <= 43200, `TTL ${ttl}`);
  const { presence } = await store.load("TTLX", { id: "abcd1234", at: 1234 });
  assert.equal(presence.abcd1234, 1234);
  const again = await store.load("TTLX");
  assert.equal(again.presence.abcd1234, 1234);
});

test("잘못된 토큰은 오류로 드러남", { skip: !hasRedis }, async () => {
  const bad = new UpstashStore({ url: shim.url, token: "wrong" });
  await assert.rejects(() => bad.load("TEST"), /Redis 요청 실패 \(401\)/);
});

test("전체 게임을 실제 Redis로: API 통합 테스트 재실행 + 명령 수 측정", { skip: !hasRedis, timeout: 180000 }, async () => {
  const before = shim.counter.commands;
  const env = { ...process.env, UPSTASH_REDIS_REST_URL: shim.url, UPSTASH_REDIS_REST_TOKEN: "test-token", H13_TIME_SCALE: "0.01" };
  delete env.NODE_TEST_CONTEXT; // 자식 테스트가 일반 TAP으로 출력하도록
  // shim이 같은 프로세스에서 응답해야 하므로 비동기로 실행
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "tests/api.test.js"], { env });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.on("close", (status) => resolve({ status, stdout }));
  });
  const summary = r.stdout.split("\n").filter((l) => /^# (pass|fail)|^not ok|저장소 종류/.test(l)).join("\n");
  console.log(summary);
  assert.equal(r.status, 0, r.stdout.slice(-3000));
  assert.match(r.stdout, /저장소 종류: upstash/);
  console.log(`# Redis 명령 수 (API 테스트 전체): ${shim.counter.commands - before}`);
});
