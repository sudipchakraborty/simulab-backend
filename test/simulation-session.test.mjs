import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createCompanion } from "../src/service.mjs";

test("simulation sessions require trusted loopback origin, own builds, expire and cannot access hardware", async () => {
  const root = await mkdtemp(join(tmpdir(), "simulab-session-"));
  let clock = 1000;
  const calls = [];
  const runner = async (args) => {
    calls.push(args[0]);
    if (args[0] === "compile")
      await writeFile(
        join(args[args.indexOf("--output-dir") + 1], "sketch.ino.hex"),
        ":00000001FF\n",
      );
    return { code: 0, stdout: "ok", stderr: "" };
  };
  const origin = "http://127.0.0.1:5173";
  const server = createCompanion({
    token: "private-terminal-token",
    origins: [origin, "https://remote.example"],
    root,
    runner,
    now: () => clock,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { session, body, headers = {}, ...options } = {}) =>
    fetch(base + path, {
      method: body !== undefined ? "POST" : "GET",
      ...options,
      headers: {
        Origin: origin,
        ...(session ? { Authorization: `Bearer ${session}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  try {
    assert.equal(
      (
        await request("/simulation/session", {
          body: {},
          headers: { Origin: "" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/simulation/session", {
          body: {},
          headers: { Origin: "https://remote.example" },
        })
      ).status,
      403,
    );
    const hostileHostStatus = await new Promise((resolve, reject) => {
      const req = httpRequest(
        base + "/simulation/session",
        {
          method: "POST",
          headers: {
            Host: "evil.example",
            Origin: origin,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(hostileHostStatus, 403);
    assert.equal(
      (
        await request("/simulation/session", {
          body: {},
          headers: { "Content-Type": "text/plain" },
        })
      ).status,
      415,
    );
    assert.equal(
      (await request("/simulation/session", { body: [] })).status,
      400,
    );
    assert.equal(
      (
        await request("/simulation/session", {
          body: { value: "x".repeat(1100) },
        })
      ).status,
      413,
    );
    const issued = await request("/simulation/session", { body: {} });
    assert.equal(issued.status, 200);
    const first = await issued.json();
    assert.match(first.session, /^[a-f0-9]{64}$/);
    assert.ok(first.expiresAt > clock + 1900000);
    assert.equal(
      JSON.stringify(first).includes("private-terminal-token"),
      false,
    );
    const second = await (
      await request("/simulation/session", { body: {} })
    ).json();
    assert.equal(
      (await request("/status", { session: first.session })).status,
      200,
    );
    assert.equal(
      (
        await request("/status", {
          session: first.session,
          headers: { Origin: "" },
        })
      ).status,
      403,
    );
    for (const [path, body] of [
      ["/ports"],
      ["/libraries"],
      ["/libraries/install", { name: "RTClib" }],
      ["/authorize-upload", { confirm: true }],
      ["/upload", { consent: "forged" }],
    ]) {
      assert.equal(
        (await request(path, { session: first.session, body })).status,
        403,
        path,
      );
    }
    const build = await (
      await request("/compile", {
        session: first.session,
        body: {
          board: "uno",
          files: [
            { name: "sketch.ino", content: "void setup(){} void loop(){}" },
          ],
        },
      })
    ).json();
    assert.equal(build.success, true);
    const artifactPath = `/artifact/${build.job}/sketch.ino.hex`;
    assert.equal(
      (await request(artifactPath, { session: first.session })).status,
      200,
    );
    assert.equal(
      (await request(artifactPath, { session: second.session })).status,
      404,
    );
    assert.equal(
      (await request(artifactPath, { session: "private-terminal-token" }))
        .status,
      200,
    );
    assert.equal(calls.includes("upload"), false);
    const streamedStatus = await new Promise((resolve, reject) => {
      const req = httpRequest(
        base + "/compile",
        {
          method: "POST",
          headers: {
            Origin: origin,
            Authorization: `Bearer ${first.session}`,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.write('{"board":"uno",');
      setTimeout(() => {
        clock = first.expiresAt;
        req.end('"files":[{"name":"sketch.ino","content":"x"}]}');
      }, 30);
    });
    assert.equal(streamedStatus, 401);
    assert.equal(calls.filter((call) => call === "compile").length, 1);
    assert.equal(
      (await request(artifactPath, { session: first.session })).status,
      401,
    );
    assert.equal(
      (await request("/status", { session: "private-terminal-token" })).status,
      200,
    );
    for (let i = 0; i < 12; i++)
      assert.equal(
        (await request("/simulation/session", { body: {} })).status,
        200,
      );
    assert.equal(
      (await request("/simulation/session", { body: {} })).status,
      429,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
