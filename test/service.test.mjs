import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompanion, validateFiles } from "../src/service.mjs";
test("rejects traversal, unknown extensions and excessive source", () => {
  for (const name of ["../evil.ino", "foo/bar.h", "evil.cmd", "CON.ino"])
    assert.throws(() => validateFiles([{ name, content: "x" }]));
  assert.throws(() =>
    validateFiles([{ name: "sketch.ino", content: "x".repeat(1_000_001) }]),
  );
});
test("HTTP auth/origin, fixed compile commands, diagnostics and single-use hardware consent", async () => {
  const root = await mkdtemp(join(tmpdir(), "simulab-test-")),
    calls = [];
  // Explicit CLI test double; real compilation is tested separately against downloaded Arduino CLI.
  const runner = async (args) => {
    calls.push(args);
    if (args[0] === "board")
      return {
        code: 0,
        stdout: JSON.stringify({
          detected_ports: [
            { port: { address: "COM42" }, matching_boards: [] },
            {
              port: { address: "COM43" },
              matching_boards: [{ fqbn: "esp32:esp32:esp32" }],
            },
          ],
        }),
        stderr: "",
      };
    if (args[0] === "compile") {
      await writeFile(
        join(args[args.indexOf("--output-dir") + 1], "sketch.ino.hex"),
        ":00000001FF\n",
      );
      return { code: 0, stdout: "compiled", stderr: "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
  const server = createCompanion({
    token: "test-secret",
    origins: ["http://127.0.0.1:5174"],
    root,
    runner,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const request = async (path, body, headers = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Origin: "http://127.0.0.1:5174",
        Authorization: "Bearer test-secret",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    assert.equal(
      (await request("/status", null, { Authorization: "bad" })).status,
      401,
    );
    assert.equal(
      (await request("/status", null, { Origin: "https://evil.example" }))
        .status,
      403,
    );
    assert.equal(
      (
        await request("/compile", {
          board: "evil;cmd",
          files: [{ name: "sketch.ino", content: "" }],
        })
      ).status,
      400,
    );
    const result = await (
      await request("/compile", {
        board: "uno",
        files: [
          { name: "sketch.ino", content: "void setup(){} void loop(){}" },
        ],
      })
    ).json();
    assert.equal(result.success, true);
    assert.ok(calls.some((a) => a.includes("arduino:avr:uno")));
    assert.equal(
      (
        await request("/upload", {
          job: result.job,
          port: "COM42",
          consent: "missing",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/authorize-upload", {
          job: result.job,
          port: "COM43",
          confirm: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (await request("/libraries/install", { name: "unapproved;command" }))
        .status,
      400,
    );
    const grant = await (
      await request("/authorize-upload", {
        job: result.job,
        port: "COM42",
        confirm: true,
      })
    ).json();
    const body = { job: result.job, port: "COM42", consent: grant.consent };
    assert.equal((await request("/upload", body)).status, 200);
    assert.equal((await request("/upload", body)).status, 403);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
});
