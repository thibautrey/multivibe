import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const dev = process.argv.includes("--dev");
const controlPort = process.env.CONTROL_PLANE_PORT || "1456";
const edgePort = process.env.V1_EDGE_PORT || process.env.PORT || "1455";
const env = { ...process.env,
  MULTIVIBE_CONTROL_PLANE: "true", CONTROL_PLANE_PORT: controlPort,
  V1_EDGE_PORT: edgePort, V1_EDGE_HOST: process.env.V1_EDGE_HOST || "127.0.0.1",
  NODE_CONTROL_PLANE_URL: `http://127.0.0.1:${controlPort}`,
  V1_EDGE_BASE_URL: `http://127.0.0.1:${edgePort}`,
  V1_EDGE_INTERNAL_JOB_TOKEN: process.env.V1_EDGE_INTERNAL_JOB_TOKEN || randomBytes(32).toString("base64url"),
  PORT: controlPort, HOST: "127.0.0.1",
};
const build = spawn("cargo", ["build", "-p", "multivibe-v1-edge"], { cwd: root, env, stdio: "inherit" });
const result = await new Promise((resolve) => {
  build.on("error", () => resolve(1));
  build.on("exit", (code) => resolve(code ?? 1));
});
if (result) process.exit(result);
const target = path.resolve(root, process.env.CARGO_TARGET_DIR || "target");
const children = [
  spawn(process.execPath, dev
    ? ["--import", "tsx", "--watch", "--import", "./src/instrument.ts", "src/server.ts"]
    : ["--import", "./dist/instrument.js", "dist/server.js"], { cwd: root, env, stdio: "inherit" }),
  spawn(path.join(target, "debug", `multivibe-v1-edge${process.platform === "win32" ? ".exe" : ""}`), [], { cwd: root, env, stdio: "inherit" }),
];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
  const timeout = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 10000);
  timeout.unref();
}
for (const child of children) {
  child.on("error", (error) => { console.error(error.message); stop(1); });
  child.on("exit", (code) => stop(code ?? 1));
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
