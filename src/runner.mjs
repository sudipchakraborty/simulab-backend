import { spawn } from "node:child_process";
import { createNativeCompiler } from "./compiler-rpc.mjs";
import { createToolchainFingerprint } from "./toolchain-fingerprint.mjs";
/** @brief Run a fixed executable without a shell; bound duration and combined log bytes. */
export function commandRunner(executable, configFile) {
  const timeoutMs = Number(process.env.SIMULAB_TOOLCHAIN_TIMEOUT_MS ?? 600000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000)
    throw new Error("Trusted toolchain timeout must be 1000..1800000 ms");
  const native = createNativeCompiler(executable, configFile, { timeoutMs });
  const cli = (args, options = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        executable,
        configFile ? ["--config-file", configFile, ...args] : args,
        { shell: false, windowsHide: true },
      );
      let stdout = "",
        stderr = "",
        size = 0,
        finished = false;
      const terminate = () => {
        if (process.platform === "win32" && child.pid)
          spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          });
        else child.kill();
      };
      const timer = setTimeout(() => {
        terminate();
        reject(
          Object.assign(
            new Error(
              `Toolchain timed out after ${timeoutMs / 1000} seconds; retry reuses the per-board build cache`,
            ),
            { status: 504 },
          ),
        );
      }, options.timeoutMs ?? timeoutMs);
      const collect = (field) => (chunk) => {
        size += chunk.length;
        if (size > 2_000_000) {
          terminate();
          return;
        }
        if (field === "out") stdout += chunk;
        else stderr += chunk;
      };
      child.stdout.on("data", collect("out"));
      child.stderr.on("data", collect("err"));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (finished) return;
        finished = true;
        resolve({
          code: size > 2_000_000 ? -1 : code,
          stdout,
          stderr: stderr + (size > 2_000_000 ? "\nLog limit exceeded" : ""),
        });
      });
    });
  const mode = process.env.SIMULAB_COMPILER_TRANSPORT ?? "grpc";
  if (!["grpc", "cli"].includes(mode)) throw new Error("Invalid compiler transport");
  const run = (args, options = {}) => {
    if (args[0] !== "compile") return cli(args, options);
    if (mode === "grpc") return native.compile(args, options);
    options.onProgress?.({ stage: "Compiling (percentage unavailable in compatibility mode)" });
    return cli(args, options);
  };
  /** @brief Revalidate external installed tool/core/library changes before every exact artifact-cache lookup. */
  run.fingerprint = createToolchainFingerprint({ cli, executable, configFile });
  run.invalidate = () => native.invalidate();
  run.close = () => { run.fingerprint.close(); return native.close(); };
  return run;
}
