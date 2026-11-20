/**
 * 저장소: Upstash Redis(REST) 또는 로컬 개발용 메모리.
 *
 * 방 1개 = Redis 해시 h13:room:{code} { ver, data(JSON) }
 * 접속 표시 = Redis 해시 h13:pres:{code} { playerId: 마지막 접속 시각(ms) }
 * 쓰기는 버전 비교 후 교체(CAS, Lua)로만 한다 → 동시에 제출해도 덮어쓰기 없음.
 */

const TTL_SEC = 60 * 60 * 12; // 마지막 변경 후 12시간 보관

const CAS_SCRIPT = `
local cur = redis.call('HGET', KEYS[1], 'ver')
if (not cur and ARGV[1] == '0') or cur == ARGV[1] then
  redis.call('HSET', KEYS[1], 'ver', ARGV[2], 'data', ARGV[3])
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
  return 1
end
return 0
`;

const roomKey = (code) => `h13:room:${code}`;
const presKey = (code) => `h13:pres:${code}`;

function redisEnv() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

function hashToObject(arr) {
  const out = {};
  if (Array.isArray(arr)) for (let i = 0; i < arr.length; i += 2) out[arr[i]] = arr[i + 1];
  else if (arr && typeof arr === "object") Object.assign(out, arr);
  return out;
}

class UpstashStore {
  constructor({ url, token }) {
    this.url = url;
    this.token = token;
    this.kind = "upstash";
  }

  async #post(path, body) {
    const res = await fetch(this.url + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || json === null) {
      throw new Error(`Redis 요청 실패 (${res.status}): ${json && json.error ? json.error : "응답 없음"}`);
    }
    return json;
  }

  async #pipeline(cmds) {
    const out = await this.#post("/pipeline", cmds);
    return out.map((x) => {
      if (x.error) throw new Error(`Redis 오류: ${x.error}`);
      return x.result;
    });
  }

  /** 방 + 접속 표시를 한 번에 읽는다 (Redis 명령 2개, 요청 1번) */
  async load(code, beat) {
    const cmds = [["HMGET", roomKey(code), "ver", "data"], ["HGETALL", presKey(code)]];
    if (beat) cmds.push(["HSET", presKey(code), beat.id, String(beat.at)], ["EXPIRE", presKey(code), String(TTL_SEC)]);
    const [[ver, data], pres] = await this.#pipeline(cmds);
    const presence = Object.fromEntries(Object.entries(hashToObject(pres)).map(([k, v]) => [k, Number(v)]));
    if (beat) presence[beat.id] = beat.at;
    if (!ver || !data) return { ver: "0", room: null, presence };
    return { ver, room: JSON.parse(data), presence };
  }

  async cas(code, expected, next, room) {
    const out = await this.#post("", ["EVAL", CAS_SCRIPT, "1", roomKey(code), expected, next, JSON.stringify(room), String(TTL_SEC)]);
    if (out.error) throw new Error(`Redis 오류: ${out.error}`);
    return Number(out.result) === 1;
  }
}

class MemoryStore {
  constructor() {
    this.rooms = new Map();
    this.pres = new Map();
    this.kind = "memory";
  }
  async load(code, beat) {
    const presence = { ...(this.pres.get(code) || {}) };
    if (beat) {
      presence[beat.id] = beat.at;
      this.pres.set(code, presence);
    }
    const hit = this.rooms.get(code);
    if (!hit) return { ver: "0", room: null, presence };
    return { ver: hit.ver, room: JSON.parse(hit.data), presence };
  }
  async cas(code, expected, next, room) {
    const hit = this.rooms.get(code);
    const cur = hit ? hit.ver : "0";
    if (cur !== expected) return false;
    this.rooms.set(code, { ver: next, data: JSON.stringify(room) });
    return true;
  }
}

let cached = null;

/** 환경에 맞는 저장소. Vercel에서 Redis가 연결 안 됐으면 null (설정 안내를 띄우기 위함). */
export function getStore() {
  if (cached) return cached;
  const env = redisEnv();
  if (env) cached = new UpstashStore(env);
  else if (process.env.VERCEL) cached = null;
  else cached = new MemoryStore();
  return cached;
}

/** 테스트용: 저장소 교체 */
export function setStore(store) {
  cached = store;
}

export { UpstashStore, MemoryStore, CAS_SCRIPT };
