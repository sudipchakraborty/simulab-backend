import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCompanion } from "./service.mjs";
import { commandRunner } from "./runner.mjs";
const local = fileURLToPath(new URL("../.local/", import.meta.url));
const token = process.env.SIMULAB_TOKEN || randomBytes(32).toString("hex");
const origins = (
  process.env.SIMULAB_ORIGINS ||
  "http://127.0.0.1:5173,http://127.0.0.1:5174,http://127.0.0.1:5175,http://localhost:5173"
).split(",");
const executable =
  process.env.ARDUINO_CLI ||
  resolve(
    local,
    process.platform === "win32" ? "arduino-cli.exe" : "arduino-cli",
  );
const runner = commandRunner(
  executable,
  process.env.ARDUINO_CONFIG || resolve(local, "arduino-cli.yaml"),
);
const server = createCompanion({
  token,
  origins,
  root: resolve(local, "jobs"),
  runner,
});
server.listen(4317, "127.0.0.1", () =>
  console.log(
    `SimuLab local companion: http://127.0.0.1:4317\nPairing token (keep private): ${token}\nOnly explicitly authorized uploads modify hardware.`,
  ),
);
