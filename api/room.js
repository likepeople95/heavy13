/**
 * Vercel 함수: /api/room
 *  GET  ?code=ABCD&token=...&beat=1   → 내 화면 데이터 (지난 마감 시각 처리 포함)
 *  POST { action, code, token, ... }  → create | join | leave | kick | settings | start | submit | place | pass | rematch
 */
import { getStore } from "../lib/store.js";
import { act, advance, createRoom, playerByToken, randomCode, RoomError, viewFor } from "../lib/room.js";

const MAX_RETRY = 6;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8") || "{}");
    return req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

const cleanCode = (x) => String(x || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
const nextVer = (ver) => String(Number(ver) + 1);

/** 읽고 → 바꾸고 → 버전 비교 후 저장. 다른 사람이 먼저 저장했으면 처음부터 다시. */
async function mutate(store, code, fn, beat) {
  for (let i = 0; i < MAX_RETRY; i++) {
    const { ver, room, presence } = await store.load(code, i === 0 ? beat : null);
    if (!room) throw new RoomError("방을 찾을 수 없어요. 코드를 확인해 주세요", 404);
    const now = Date.now();
    const draft = structuredClone(room);
    advance(draft, now);
    const extra = fn ? fn(draft, now) : {};
    const changed = fn ? true : JSON.stringify(draft) !== JSON.stringify(room);
    if (!changed) return { room, presence, now, extra };
    if (await store.cas(code, ver, nextVer(ver), draft)) return { room: draft, presence, now, extra };
    await new Promise((r) => setTimeout(r, 15 + Math.random() * 40));
  }
  throw new RoomError("동시에 요청이 몰렸어요. 다시 시도해 주세요", 503);
}

export default async function handler(req, res) {
  const store = getStore();
  if (!store) {
    return send(res, 503, {
      error: "저장소(Upstash Redis)가 연결되지 않았어요. Vercel 프로젝트 → Storage에서 Upstash Redis를 연결한 뒤 다시 배포해 주세요.",
      setup: true,
    });
  }
  try {
    if (req.method === "GET") {
      const url = new URL(req.url, "http://x");
      const code = cleanCode(url.searchParams.get("code"));
      const token = url.searchParams.get("token") || "";
      if (code.length !== 4) throw new RoomError("방 코드는 영문 4자리예요");
      // 접속 표시용 하트비트(beat=내 id)는 방 읽기와 같은 요청에 묶어 Redis 왕복을 줄인다
      const beatId = (url.searchParams.get("beat") || "").replace(/[^0-9a-f]/g, "").slice(0, 8);
      const { room, presence, now } = await mutate(store, code, null, beatId ? { id: beatId, at: Date.now() } : null);
      const me = playerByToken(room, token);
      if (beatId && (!me || me.id !== beatId)) delete presence[beatId];
      return send(res, 200, viewFor(room, me, now, presence));
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const action = String(body.action || "");

      if (action === "create") {
        for (let i = 0; i < 10; i++) {
          const code = randomCode();
          const now = Date.now();
          const { room, player } = createRoom(code, body.name, body.settings, now);
          if (await store.cas(code, "0", "1", room)) {
            return send(res, 200, { code, token: player.token, view: viewFor(room, player, now, { [player.id]: now }) });
          }
        }
        throw new RoomError("방 코드를 만들지 못했어요. 다시 시도해 주세요", 503);
      }

      const code = cleanCode(body.code);
      if (code.length !== 4) throw new RoomError("방 코드는 영문 4자리예요");
      let token = String(body.token || "");
      const { room, presence, now, extra } = await mutate(store, code, (draft, at) => {
        const me = playerByToken(draft, token);
        return act(draft, me, action, body, at);
      });
      if (extra && extra.token) token = extra.token;
      const me = playerByToken(room, token);
      if (me) presence[me.id] = now;
      return send(res, 200, { ...extra, view: viewFor(room, me, now, presence) });
    }

    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { error: "허용되지 않은 요청이에요" });
  } catch (e) {
    if (e instanceof RoomError) return send(res, e.status, { error: e.message });
    if (e instanceof SyntaxError) return send(res, 400, { error: "요청 형식이 잘못됐어요" });
    console.error(e);
    return send(res, 500, { error: "서버 오류가 났어요. 잠시 후 다시 시도해 주세요" });
  }
}
