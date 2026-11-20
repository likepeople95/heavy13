/**
 * 화면 버전이 세 곳에서 같은지 확인한다. 하나만 올리면 예전 탭이 새로고침을 못 하거나
 * 반대로 계속 새로고침하려 하므로, 배포 전에 여기서 걸러낸다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { APP_VERSION } from "../lib/room.js";

test("APP_VERSION이 lib/room.js · public/app.js · public/index.html에서 같다", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const inApp = app.match(/const APP_VERSION = "([^"]+)"/)?.[1];
  assert.equal(inApp, APP_VERSION, "public/app.js의 APP_VERSION");
  const tags = [...html.matchAll(/(?:style\.css|app\.js)\?v=([^"]+)"/g)].map((m) => m[1]);
  assert.equal(tags.length, 2, "index.html의 style.css·app.js에 ?v= 가 있어야 함");
  tags.forEach((v) => assert.equal(v, APP_VERSION, "index.html의 ?v="));
});
