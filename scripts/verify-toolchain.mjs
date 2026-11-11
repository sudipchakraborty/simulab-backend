import { request as httpRequest } from "node:http";
/** @file Real Arduino CLI compile/failure/discovery evidence through the actual companion HTTP API. */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createCompanion } from "../src/service.mjs";
import { commandRunner } from "../src/runner.mjs";
const local = fileURLToPath(new URL("../.local/", import.meta.url)),
  token = "local-verification-only";
const server = createCompanion({
  token,
  origins: [],
  root: resolve(local, "verification"),
  runner: commandRunner(
    resolve(local, "arduino-cli.exe"),
    resolve(local, "arduino-cli.yaml"),
  ),
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
async function request(path, body) {
  return new Promise((resolve, reject) => {
    const content = body ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(content),
              }
            : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          if (res.statusCode !== 200) reject(new Error(text));
          else {
            try {
              resolve(JSON.parse(text));
            } catch (e) {
              reject(e);
            }
          }
        });
      },
    );
    req.setTimeout(1900000, () =>
      req.destroy(new Error("Verification request timed out")),
    );
    req.on("error", reject);
    req.end(content);
  });
}
let previous = {};
try {
  previous = JSON.parse(
    await readFile(
      new URL("../docs/TOOLCHAIN_REPORT.json", import.meta.url),
      "utf8",
    ),
  );
} catch {}
const report = {
  ...previous,
  kind: "real Arduino CLI evidence",
  hardwareUpload: "not performed",
  builds: previous.builds ?? [],
};
try {
  report.status = await request("/status");
  report.ports = await request("/ports");
  for (const board of process.argv
    .find((a) => a.startsWith("--boards="))
    ?.slice(9)
    .split(",") ??
    (process.argv.includes("--esp32")
      ? ["uno", "esp32", "esp32s3", "yd-n16r8"]
      : ["uno"])) {
    const source = await readFile(
      new URL(
        `../examples/${board === "uno" ? "uno" : "esp32s3"}/sketch.ino`,
        import.meta.url,
      ),
      "utf8",
    );
    const result = await request("/compile", {
      board,
      files: [{ name: "sketch.ino", content: source }],
    });
    if (!result.success) throw new Error(`${board}: ${result.log}`);
    report.builds = report.builds.filter((b) => b.board !== board);
    report.builds.push(result);
    await writeFile(
      new URL("../docs/TOOLCHAIN_REPORT.json", import.meta.url),
      JSON.stringify(report, null, 2),
    );
    console.log(
      `${board}: actual compilation passed (${result.artifacts.join(", ")})`,
    );
  }
  const failure = await request("/compile", {
    board: "uno",
    files: [
      {
        name: "sketch.ino",
        content: "void setup(){ unknown_function(); }\nvoid loop(){}",
      },
    ],
  });
  if (failure.success || !failure.diagnostics.length)
    throw new Error("Build failure/diagnostic mapping was not observed");
  report.failure = failure;
  await writeFile(
    new URL("../docs/TOOLCHAIN_REPORT.json", import.meta.url),
    JSON.stringify(report, null, 2),
  );
  console.log(
    "Real compile, expected build failure, diagnostic mapping and port discovery passed. No upload performed.",
  );
} finally {
  await new Promise((r) => server.close(r));
}
