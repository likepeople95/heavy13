/**
 * 테스트용: 실제 redis-server 앞에 Upstash REST API와 같은 형식의 HTTP 창구를 만든다.
 *  POST /          body: ["CMD", "arg", ...]          → { result } | { error }
 *  POST /pipeline  body: [["CMD", ...], [...]]        → [{ result } | { error }, ...]
 *  Authorization: Bearer <token> 필수
 * Lua(EVAL)·해시 명령이 진짜 Redis에서 도는지 확인하는 용도. 외부 패키지 없이 RESP를 직접 다룬다.
 */
import http from "node:http";
import net from "node:net";

function encode(args) {
  let out = `*${args.length}\r\n`;
  for (const a of args) {
    const b = Buffer.from(String(a), "utf8");
    out += `$${b.length}\r\n${b.toString("utf8")}\r\n`;
  }
  return out;
}

/** RESP 응답 하나를 buf[pos]부터 파싱. 덜 왔으면 null */
function parse(buf, pos) {
  if (pos >= buf.length) return null;
  const end = buf.indexOf("\r\n", pos);
  if (end < 0) return null;
  const type = String.fromCharCode(buf[pos]);
  const line = buf.toString("utf8", pos + 1, end);
  const next = end + 2;
  if (type === "+") return { value: line, pos: next };
  if (type === "-") return { value: { __error: line }, pos: next };
  if (type === ":") return { value: Number(line), pos: next };
  if (type === "$") {
    const len = Number(line);
    if (len < 0) return { value: null, pos: next };
    if (buf.length < next + len + 2) return null;
    return { value: buf.toString("utf8", next, next + len), pos: next + len + 2 };
  }
  if (type === "*") {
    const n = Number(line);
    if (n < 0) return { value: null, pos: next };
    const arr = [];
    let p = next;
    for (let i = 0; i < n; i++) {
      const r = parse(buf, p);
      if (!r) return null;
      arr.push(r.value);
      p = r.pos;
    }
    return { value: arr, pos: p };
  }
  throw new Error("RESP 파싱 실패: " + type);
}

class RespClient {
  constructor(port) {
    this.sock = net.connect(port, "127.0.0.1");
    this.buf = Buffer.alloc(0);
    this.waiting = [];
    this.sock.on("data", (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      for (;;) {
        if (!this.waiting.length) break;
        const r = parse(this.buf, 0);
        if (!r) break;
        this.buf = this.buf.subarray(r.pos);
        this.waiting.shift()(r.value);
      }
    });
  }
  send(args) {
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      this.sock.write(encode(args));
    });
  }
  close() {
    this.sock.end();
  }
}

const wrapResult = (v) => (v && typeof v === "object" && "__error" in v ? { error: v.__error } : { result: v });

export function startShim(redisPort, token) {
  const client = new RespClient(redisPort);
  const counter = { requests: 0, commands: 0 };
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Unauthorized" }));
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    counter.requests++;
    let out;
    if (req.url === "/pipeline") {
      out = [];
      for (const cmd of body) {
        counter.commands++;
        out.push(wrapResult(await client.send(cmd)));
      }
    } else {
      counter.commands++;
      out = wrapResult(await client.send(body));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, client, counter, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
