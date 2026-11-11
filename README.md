# SimuLab local hardware companion

Restricted Node22+ loopback service for Arduino CLI compilation, discovery, library management and explicitly authorized uploads. It reuses the existing backend repository; this is a local service, not a deployed cloud compiler.

```powershell
npm.cmd run setup:toolchain
# Optional, large ESP32 toolchain download:
npm.cmd run setup:toolchain -- --esp32
npm.cmd start
```

On Windows x64 setup downloads official Arduino CLI, verifies its published SHA256 and installs AVR1.8.6 locally. ESP32 setup installs core3.3.8. `.local` contains private toolchains, package caches, build/source/upload logs and artifacts; it is ignored by Git. No system PATH changes. Other operating systems must provide `ARDUINO_CLI` and `ARDUINO_CONFIG` explicitly. `SIMULAB_ORIGINS` is a comma-separated list of exact frontend origins; defaults cover localhost development/preview. A fresh token is printed at startup; `SIMULAB_TOKEN` can inject one for controlled local operation.

In the Code Editor tab, pair using that token, select a fixed board, then Build. Physical upload requires a currently detected port plus explicit, expiring, single-use authorization. Never expose this service through a proxy or public network. Trusted local source compilation is not an OS sandbox; untrusted multiuser cloud compilation requires separate process/container isolation.

## API

All routes require `Authorization: Bearer <token>`. POST requires JSON. Host must be127.0.0.1 with a port; provided Origin must match the configured allowlist. Service binds127.0.0.1:4317. No arbitrary shell execution or caller-selected executable/flags.

| Method/path | Request / result |
| --- | --- |
| GET /status | Real CLI version/availability and fixed board profiles |
| GET /ports | Real `arduino-cli board list --format json` |
| GET /libraries | Installed CLI libraries and install allowlist |
| POST /libraries/install | `{name}` from RTClib/Adafruit NeoPixel/FastLED only |
| POST /compile | `{board, files:[{name,content}]}`; returns job, success, log, diagnostics, artifacts |
| GET /artifact/:job/:filename | Allowlisted output artifact bytes from a successful build |
| POST /authorize-upload | `{job,port,confirm:true}`; returns single-use60second consent |
| POST /upload | `{job,port,consent}`; verified CLI upload result/log |

Source projects require `sketch.ino`,1–32 flat files, allowed source/header extensions, maximum1MB. Reserved Windows filenames, traversal and duplicate filenames are rejected. Only10 builds per process are retained; jobs expire after1hour. On disk, previous process caches remain for local troubleshooting and can be removed while the service is stopped. Processes have600second timeout and2MB log bounds. Build logs are preserved; incremental reuse follows Arduino CLI core caches. No firmware commands run on hardware without upload consent. Physical serial uses browser Web Serial rather than an unauthenticated socket bridge.

`npm.cmd test` checks HTTP/security/upload replay with an explicitly marked CLI test double. `node scripts/verify-toolchain.mjs` executes the real Uno compile, intentional compile failure, diagnostic mapping and discovery; add `--esp32` after installing ESP tools. Evidence is in `docs/TOOLCHAIN_REPORT.json`. Hardware absence is recorded separately. Tests never flash a board automatically.

See [Arduino CLI](https://docs.arduino.cc/arduino-cli/), [upload command](https://docs.arduino.cc/arduino-cli/commands-reference/arduino-cli_upload), and frontend `docs/INTEGRATED_IDE.md` for UI/limitations.

Cold ESP32 core builds can be slow on Windows. To allow up to30minutes on a trusted local host, set `$env:SIMULAB_TOOLCHAIN_TIMEOUT_MS="1800000"` before `npm.cmd start` (default600000ms; allowed1000..1800000). This is host configuration, never a frontend-supplied command option. Interrupted builds invalidate their core archive before retry; source/error logs remain in the private job cache. `node scripts/verify-toolchain.mjs --boards=esp32s3,yd-n16r8` resumes selected verification targets while retaining previous evidence.
