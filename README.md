# SimuLab local hardware companion

Restricted Node22+ loopback service for Arduino CLI compilation, discovery, library management and explicitly authorized uploads. It reuses the existing backend repository; this is a local service, not a deployed cloud compiler.

```powershell
npm.cmd run setup:toolchain
# Optional, large ESP32 toolchain download:
npm.cmd run setup:toolchain -- --esp32
npm.cmd start
```

On Windows x64 setup downloads official Arduino CLI, verifies its published SHA256 and installs AVR1.8.6 locally. ESP32 setup installs core3.3.8. `.local` contains private toolchains, package caches, build/source/upload logs and artifacts; it is ignored by Git. No system PATH changes. Other operating systems must provide `ARDUINO_CLI` and `ARDUINO_CONFIG` explicitly. `SIMULAB_ORIGINS` is a comma-separated list of exact frontend origins; defaults cover localhost development/preview. A fresh token is printed at startup; `SIMULAB_TOKEN` can inject one for controlled local operation.

In the Code Editor drawer, Build and Run acquire a simulation-only session automatically. Pair using the private terminal token for library management, port discovery and physical upload. Physical upload requires a currently detected port plus explicit, expiring, single-use authorization. Never expose this service through a proxy or public network. Trusted local source compilation is not an OS sandbox; untrusted multiuser cloud compilation requires separate process/container isolation.

## API

Authenticated routes require `Authorization: Bearer <credential>`. POST requires JSON. Host must be127.0.0.1 with a port; provided Origin must match the configured allowlist. Service binds127.0.0.1:4317. No arbitrary shell execution or caller-selected executable/flags.

Compilation retains one stable source workspace and incremental build directory per allowlisted board. Unchanged files retain their modification times; removed source files are removed from that workspace. A bounded exact-input artifact cache retains at most10builds/256MiB for one hour in this service process. Every hit verifies the saved bytes and copies them into a new job owned by the requesting session. Explicit includes, macro includes, include probes, embedded external files, build-time macros and host include-path overrides conservatively bypass exact artifact reuse and still use the real incremental compiler.

Compiler configuration, installed platform/tool versions and active compile-recipe dependency roots select the cache fingerprint. Initial validation scans the selected compiler/SDK/core trees and installed user/builtin libraries. Source/configuration files up to2MB are content-hashed as well as file names, sizes and modification times; larger/binary inputs use metadata. Watcher notifications recheck the notified input's metadata/content signature, so Windows access-time events caused by reading an unchanged SDK do not invalidate it. Real changes require a fresh full scan. Missing-directory parent watches ignore unrelated sibling files. Unknown notifications require full validation; unavailable watchers require two matching full snapshots on every lookup. Scans are capped at200,000files/20,000directories,60seconds and512MiB of source content; failed validation cannot return cached artifacts. Known toolchain changes also clear that board's incremental objects before compiling. The first adoption of an older build directory lets Arduino CLI validate its existing cache. Unrelated debugger/SDK packages are excluded from the scan.

The default compile transport reads real global work percentages from the official Arduino CLI gRPC stream (verified with CLI1.5.1). Its daemon belongs to this process, binds only127.0.0.1 on an OS-selected port, uses no shell and exits with the companion. RPC frames, logs and timeouts are bounded. Trusted hosts can set `SIMULAB_COMPILER_TRANSPORT=cli` for the legacy transport; that mode explicitly reports percentage unavailable instead of inventing progress. Work percentage does not imply a linear estimate of time remaining.

`POST /simulation/session` accepts a bounded JSON object from an exact configured HTTP loopback Origin, without the terminal token. It returns a fresh memory-only credential and expiry, valid for one hour. Credentials are capped at64 live sessions and12 issuances per origin per minute. A scoped credential permits only CLI status, compile and reads of its own artifacts; it cannot discover ports, install libraries, authorize or upload to hardware. The private terminal token retains its existing capabilities and is never returned by this endpoint. Authorization is rechecked after body streaming.

| Method/path | Request / result |
| --- | --- |
| POST /simulation/session | `{}`; returns `{session, expiresAt}` for simulation-only access |
| GET /status | Real CLI version/availability and fixed board profiles |
| GET /ports | Real `arduino-cli board list --format json` |
| GET /libraries | Installed CLI libraries and install allowlist |
| POST /libraries/install | `{name}` from RTClib/Adafruit NeoPixel/FastLED only |
| POST /compile | `{board, files:[{name,content}], requestId?}`; returns job, success, log, diagnostics, artifacts, cached, durationMs; optional requestId is32lowercase hexadecimal characters |
| GET /compile-progress/:requestId | Own request only: `{percent,stage,elapsedMs,estimatedRemainingMs?}`; percent is null until actual compiler telemetry arrives; remaining time is an estimate from measured successful builds |
| GET /artifact/:job/:filename | Allowlisted output artifact bytes from a successful build |
| POST /authorize-upload | `{job,port,confirm:true}`; returns single-use60second consent |
| POST /upload | `{job,port,consent}`; verified CLI upload result/log |

Source projects require `sketch.ino`,1–32 flat files, allowed source/header extensions, maximum1MB. Reserved Windows filenames, traversal and duplicate filenames are rejected. Only10 builds per process are retained; jobs expire after1hour. On disk, previous process caches remain for local troubleshooting and can be removed while the service is stopped. Processes have600second timeout and2MB log bounds. Build logs are preserved; incremental reuse follows Arduino CLI core caches. No firmware commands run on hardware without upload consent. Physical serial uses browser Web Serial rather than an unauthenticated socket bridge.

`npm.cmd test` checks HTTP/security/upload replay with an explicitly marked CLI test double. `node scripts/verify-toolchain.mjs` executes the real Uno compile, intentional compile failure, diagnostic mapping and discovery; add `--esp32` after installing ESP tools. Evidence is in `docs/TOOLCHAIN_REPORT.json`. Hardware absence is recorded separately. Tests never flash a board automatically.

See [Arduino CLI](https://docs.arduino.cc/arduino-cli/), [upload command](https://docs.arduino.cc/arduino-cli/commands-reference/arduino-cli_upload), and frontend `docs/INTEGRATED_IDE.md` for UI/limitations.

Cold ESP32 core builds can be slow on Windows. To allow up to30minutes on a trusted local host, set `$env:SIMULAB_TOOLCHAIN_TIMEOUT_MS="1800000"` before `npm.cmd start` (default600000ms; allowed1000..1800000). This is host configuration, never a frontend-supplied command option. Interrupted builds invalidate their core archive before retry; source/error logs remain in the private job cache. `node scripts/verify-toolchain.mjs --boards=esp32s3,yd-n16r8` resumes selected verification targets while retaining previous evidence.
