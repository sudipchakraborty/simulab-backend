import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { boards } from "./boards.mjs";
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const allowedLibraries = ["RTClib", "Adafruit NeoPixel", "FastLED"];
/** @brief Validate a bounded flat Arduino source project; reject reserved Windows filenames. */
export function validateFiles(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 32)
    fail(400, "Expected 1..32 source files");
  let bytes = 0;
  const names = new Set();
  for (const f of files) {
    if (
      !f ||
      typeof f.name !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}\.(ino|h|hpp|cpp|c)$/.test(f.name) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])\./i.test(f.name) ||
      names.has(f.name.toLowerCase()) ||
      typeof f.content !== "string"
    )
      fail(400, "Invalid or duplicate source filename");
    names.add(f.name.toLowerCase());
    bytes += Buffer.byteLength(f.content);
  }
  if (!names.has("sketch.ino") || bytes > 1_000_000)
    fail(400, "Project requires sketch.ino and must be below 1 MB");
  return files;
}
/** @brief Create restricted loopback HTTP companion with injected runner for testability.
 * @param options Trusted host configuration: token, exact allowed origins, private root and fixed CLI runner.
 */
export function createCompanion({ token, origins, root, runner }) {
  if (typeof token !== "string" || token.length < 8)
    throw new Error("Companion token is required");
  const jobs = new Map(),
    consents = new Map();
  let busy = false;
  const ports = async () => {
    const r = await runner(["board", "list", "--format", "json"]);
    if (r.code !== 0) fail(503, r.stderr || r.stdout);
    const data = JSON.parse(r.stdout);
    return data.detected_ports ?? data;
  };
  const knownPort = async (port, boardId) => {
    const detected =
      typeof port === "string"
        ? (await ports()).find((p) => p.port?.address === port)
        : undefined;
    if (!detected) fail(400, "Select a currently detected board port");
    const matches = detected.matching_boards ?? [],
      base = boards[boardId].fqbn.split(":").slice(0, 3).join(":");
    if (
      matches.length &&
      !matches.some((b) => b.fqbn?.split(":").slice(0, 3).join(":") === base)
    )
      fail(400, "Detected board does not match the selected build profile");
  };
  const getJob = (id) => {
    const j = jobs.get(id);
    if (!j || Date.now() - j.created > 3600000)
      fail(404, "Build expired; compile again");
    return j;
  };
  return createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(data));
    };
    try {
      const origin = req.headers.origin;
      if (origin && !origins.includes(origin)) fail(403, "Origin denied");
      if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? ""))
        fail(403, "Host denied");
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Allow-Private-Network": "true",
        });
        res.end();
        return;
      }
      const supplied = Buffer.from(req.headers.authorization ?? ""),
        expected = Buffer.from("Bearer " + token);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        fail(401, "Pair with the companion token shown in your local terminal");
      let data = {};
      if (req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          fail(415, "Expected application/json");
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 1_100_000)
            fail(413, "Request too large");
        }
        try {
          data = JSON.parse(body);
        } catch {
          fail(400, "Invalid JSON");
        }
        if (!data || typeof data !== "object" || Array.isArray(data))
          fail(400, "Expected a JSON object");
      }
      const path = new URL(req.url, "http://127.0.0.1").pathname;
      if (req.method === "GET" && path === "/status") {
        const r = await runner(["version", "--format", "json"]);
        send(200, {
          available: r.code === 0,
          version: r.stdout,
          boards,
          hardwareVerified: false,
        });
        return;
      }
      if (req.method === "GET" && path === "/ports") {
        send(200, { ports: await ports() });
        return;
      }
      if (req.method === "GET" && path === "/libraries") {
        const r = await runner(["lib", "list", "--format", "json"]);
        send(r.code === 0 ? 200 : 503, {
          output: r.stdout,
          error: r.stderr,
          allowedLibraries,
        });
        return;
      }
      if (req.method === "POST" && path === "/libraries/install") {
        if (!allowedLibraries.includes(data.name))
          fail(400, "Library is not in the approved component library list");
        if (busy) fail(409, "Toolchain is busy");
        busy = true;
        try {
          const r = await runner(["lib", "install", data.name]);
          send(200, { success: r.code === 0, log: r.stdout + "\n" + r.stderr });
        } finally {
          busy = false;
        }
        return;
      }
      if (req.method === "POST" && path === "/compile") {
        if (busy) fail(409, "Toolchain is busy");
        if (!Object.hasOwn(boards, data.board))
          fail(400, "Unknown board profile");
        validateFiles(data.files);
        busy = true;
        try {
          // Bound retained artifacts, and keep all filesystem destinations under this service-owned root.
          while (jobs.size >= 10) {
            const id = jobs.keys().next().value;
            await rm(join(root, id), { recursive: true, force: true });
            jobs.delete(id);
          }
          const id = randomBytes(16).toString("hex"),
            dir = join(root, id),
            sketch = join(dir, "sketch"),
            output = join(dir, "output");
          await mkdir(sketch, { recursive: true });
          await mkdir(output, { recursive: true });
          for (const f of data.files)
            await writeFile(join(sketch, f.name), f.content, "utf8");
          const args = [
            "compile",
            "--fqbn",
            boards[data.board].fqbn,
            "--jobs",
            "8",
            "--warnings",
            "all",
            "--output-dir",
            output,
            "--build-path",
            join(root, "cache", data.board),
            sketch,
          ];
          jobs.set(id, {
            board: data.board,
            output,
            artifacts: [],
            success: false,
            created: Date.now(),
          });
          let result;
          try {
            result = await runner(args);
          } catch (error) {
            await writeFile(join(dir, "build.log"), error.message);
            // An interrupted archiver can leave core.a missing otherwise-valid compiled objects.
            // Board is allowlisted and this is a single file under the service-owned cache.
            await rm(join(root, "cache", data.board, "core", "core.a"), {
              force: true,
            });
            throw error;
          }
          const log = result.stdout + "\n" + result.stderr;
          await writeFile(join(dir, "build.log"), log);
          const artifacts = await readdir(output);
          const success = result.code === 0;
          jobs.set(id, {
            board: data.board,
            output,
            artifacts,
            success,
            created: Date.now(),
          });
          const diagnostics = [
            ...log.matchAll(
              /(?:^|[\r\n])([^\r\n]*?\.(?:ino|h|hpp|cpp|c)):(\d+):(\d+):\s*(error|warning):\s*([^\r\n]+)/g,
            ),
          ].map((m) => ({
            file: m[1].split(/[\\/]/).pop(),
            line: Number(m[2]),
            column: Number(m[3]),
            severity: m[4],
            message: m[5],
          }));
          send(200, {
            job: id,
            success,
            log,
            diagnostics,
            artifacts,
            board: data.board,
          });
        } finally {
          busy = false;
        }
        return;
      }
      if (req.method === "GET" && path.startsWith("/artifact/")) {
        const [, , id, name] = path.split("/"),
          job = getJob(id);
        if (
          !job.success ||
          !job.artifacts.includes(name) ||
          !/\.(hex|bin|elf)$/.test(name)
        )
          fail(404, "Artifact unavailable");
        const content = await readFile(join(job.output, name));
        if (content.length > 32 * 1024 * 1024) fail(413, "Artifact too large");
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store",
        });
        res.end(content);
        return;
      }
      if (req.method === "POST" && path === "/authorize-upload") {
        const job = getJob(data.job);
        if (!job.success || data.confirm !== true)
          fail(400, "Explicit physical upload confirmation required");
        await knownPort(data.port, job.board);
        const consent = randomBytes(24).toString("hex");
        consents.clear();
        consents.set(consent, {
          job: data.job,
          port: data.port,
          expires: Date.now() + 60000,
        });
        send(200, { consent, expiresInSeconds: 60 });
        return;
      }
      if (req.method === "POST" && path === "/upload") {
        const grant = consents.get(data.consent);
        consents.delete(data.consent);
        if (
          !grant ||
          grant.job !== data.job ||
          grant.port !== data.port ||
          grant.expires < Date.now()
        )
          fail(403, "Missing, expired or already used upload authorization");
        const job = getJob(data.job);
        await knownPort(data.port, job.board);
        if (busy) fail(409, "Toolchain is busy");
        busy = true;
        try {
          const r = await runner([
            "upload",
            "--fqbn",
            boards[job.board].fqbn,
            "--port",
            data.port,
            "--input-dir",
            job.output,
            "--verify",
          ]);
          const log = r.stdout + "\n" + r.stderr;
          await writeFile(join(root, data.job, "upload.log"), log);
          send(200, { success: r.code === 0, log });
        } finally {
          busy = false;
        }
        return;
      }
      fail(404, "Unknown operation");
    } catch (e) {
      send(e.status ?? 500, { error: e.message });
    }
  });
}
