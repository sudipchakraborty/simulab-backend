/** @file Download official Arduino CLI with published SHA256 verification; install cores locally. */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error(
    "Automatic setup currently supports Windows x64; set ARDUINO_CLI/ARDUINO_CONFIG on other hosts",
  );
const local = fileURLToPath(new URL("../.local/", import.meta.url));
await mkdir(local, { recursive: true });
const release = await fetch(
  "https://api.github.com/repos/arduino/arduino-cli/releases/latest",
  { headers: { "User-Agent": "SimuLab-local-setup" } },
).then((r) => {
  if (!r.ok) throw new Error(`Release metadata ${r.status}`);
  return r.json();
});
const asset = release.assets.find((a) => a.name.endsWith("Windows_64bit.zip")),
  checksum = release.assets.find((a) => a.name.endsWith("checksums.txt"));
if (!asset || !checksum) throw new Error("Missing official release assets");
const sums = await fetch(checksum.browser_download_url).then((r) => r.text()),
  line = sums.split("\n").find((l) => l.endsWith(asset.name));
if (!line) throw new Error("Missing published checksum");
const archive = Buffer.from(
  await fetch(asset.browser_download_url).then((r) => {
    if (!r.ok) throw new Error(`Download ${r.status}`);
    return r.arrayBuffer();
  }),
);
const sha256 = createHash("sha256").update(archive).digest("hex");
if (sha256 !== line.split(/\s+/)[0]) throw new Error("CLI checksum mismatch");
const zip = join(local, "arduino-cli.zip");
await writeFile(zip, archive);
const extract = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Expand-Archive -LiteralPath '${zip.replaceAll("'", "''")}' -DestinationPath '${local.replaceAll("'", "''")}' -Force`,
  ],
  { encoding: "utf8", windowsHide: true },
);
if (extract.status !== 0) throw new Error(extract.stderr);
const config = join(local, "arduino-cli.yaml");
await writeFile(
  config,
  JSON.stringify({
    directories: {
      data: join(local, "data"),
      downloads: join(local, "downloads"),
      user: join(local, "user"),
    },
    board_manager: {
      additional_urls: [
        "https://espressif.github.io/arduino-esp32/package_esp32_index.json",
      ],
    },
  }),
);
await writeFile(
  join(local, "provenance.json"),
  JSON.stringify(
    {
      version: release.tag_name,
      url: asset.browser_download_url,
      sha256,
      verifiedAgainst: checksum.browser_download_url,
    },
    null,
    2,
  ),
);
const cli = join(local, "arduino-cli.exe");
function run(args) {
  const r = spawnSync(cli, ["--config-file", config, ...args], {
    stdio: "inherit",
    windowsHide: true,
    timeout: 1200000,
  });
  if (r.status !== 0) throw new Error(`Arduino CLI failed: ${args.join(" ")}`);
}
run(["core", "update-index"]);
run(["core", "install", "arduino:avr@1.8.6"]);
if (process.argv.includes("--esp32"))
  run(["core", "install", "esp32:esp32@3.3.8"]);
console.log(
  "Toolchain installed locally; no system PATH changes. Use --esp32 to include ESP32 board tools.",
);
