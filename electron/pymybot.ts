import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { PymybotJson, PymybotRequest, RunResult, Settings } from "../shared/types.js";
import { resolveInside } from "./workspace.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const MAX_STDOUT = 32 * 1024 * 1024;
const STDERR_TAIL = 256 * 1024;
const MAX_TEXT_ARG = 8 * 1024 * 1024;
export const ACTIVATING = new Set(["run", "sample", "apply-sql", "agent"]);

export class RequestError extends Error {}

export interface BuildContext {
  root: string;
  settings: Settings;
}

function ident(value: unknown, what: string): string {
  if (typeof value !== "string" || !IDENT.test(value)) throw new RequestError(`Invalid ${what}: ${String(value)}`);
  return value;
}

function text(value: unknown, what: string, max = MAX_TEXT_ARG): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new RequestError(`Invalid ${what}`);
  }
  return value;
}

function int(value: unknown, low: number, high: number, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) {
    throw new RequestError(`${what} must be an integer in ${low}..${high}`);
  }
  return value;
}

function seconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 3600) {
    throw new RequestError("Timeout must be in (0, 3600] seconds");
  }
  return value;
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new RequestError(`Invalid ${what}`);
  return value;
}

function settingPath(root: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value);
}

// Every value uses --opt=value so text starting with "-" is never parsed as an option.
export function buildArgs(request: PymybotRequest, { root, settings }: BuildContext): string[] {
  const args = ["-m", "pymybot", request.command];
  const scriptsDir = path.join(root, "scripts");
  if (request.command === "scripts") {
    args.push(`--scripts-dir=${fs.existsSync(scriptsDir) ? scriptsDir : root}`);
    return args;
  }
  args.push(`--robot=${resolveInside(root, text(request.robot, "robot path"))}`);
  for (const dir of settings.modulePaths) {
    if (dir.trim()) args.push(`--module-path=${settingPath(root, dir.trim())}`);
  }
  if (settings.cameraSrcDir.trim()) args.push(`--camera-src-dir=${settingPath(root, settings.cameraSrcDir.trim())}`);
  switch (request.command) {
    case "check":
      if (request.input) args.push(`--input=${resolveInside(root, request.input)}`);
      break;
    case "hardware":
      break;
    case "query":
      args.push(`--sql=${text(request.sql, "SQL")}`);
      break;
    case "run":
      args.push(`--input=${resolveInside(root, text(request.input, "script path"))}`, `--timeout=${seconds(request.timeout)}`);
      for (const [name, value] of Object.entries(request.vars ?? {})) {
        if (typeof value !== "string" || value.includes("\0")) throw new RequestError(`Invalid value for ${name}`);
        args.push(`--var=${ident(name, "variable name")}=${value}`);
      }
      if (bool(request.allowHardware, "allowHardware")) args.push("--allow-hardware");
      break;
    case "sample":
      args.push(
        `--name=${ident(request.name, "variable name")}`,
        `--count=${int(request.count, 1, 1000, "Count")}`,
        `--interval-ms=${int(request.intervalMs, 0, 60000, "Interval")}`,
        `--timeout=${seconds(request.timeout)}`,
      );
      if (bool(request.allowHardware, "allowHardware")) args.push("--allow-hardware");
      break;
    case "apply-sql":
      args.push(`--sql=${text(request.sql, "SQL")}`);
      if (bool(request.allowHardware, "allowHardware")) args.push("--allow-hardware");
      break;
    case "agent":
      args.push(
        `--task=${text(request.task, "task", 16 * 1024)}`,
        `--timeout=${seconds(request.timeout)}`,
        `--max-requests=${int(request.maxRequests, 1, 100, "Max requests")}`,
        `--max-tool-calls=${int(request.maxToolCalls, 1, 1000, "Max tool calls")}`,
      );
      if (fs.existsSync(scriptsDir)) args.push(`--scripts-dir=${scriptsDir}`);
      for (const name of request.readVars ?? []) args.push(`--read-var=${ident(name, "read variable")}`);
      for (const name of request.cameraVars ?? []) args.push(`--camera-var=${ident(name, "camera variable")}`);
      if (settings.model.trim()) args.push(`--model=${settings.model.trim()}`);
      if (settings.baseUrl.trim()) args.push(`--base-url=${settings.baseUrl.trim()}`);
      if (settings.apiKeyEnv.trim()) args.push(`--api-key-env=${settings.apiKeyEnv.trim()}`);
      if (bool(request.allowActions, "allowActions")) args.push("--allow-actions");
      if (bool(request.allowHardware, "allowHardware")) args.push("--allow-hardware");
      break;
    default:
      throw new RequestError(`Unknown command: ${(request as { command: unknown }).command}`);
  }
  return args;
}

export function parseOutput(stdout: string): PymybotJson | null {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return null;
  try {
    const value = JSON.parse(lines[lines.length - 1]);
    if (typeof value !== "object" || value === null || typeof value.ok !== "boolean") return null;
    if (!value.ok && typeof value.error?.message !== "string") return null;
    return value as PymybotJson;
  } catch {
    return null;
  }
}

export function resolvePython(root: string | null, settings: Settings): string {
  if (settings.python.trim()) return settings.python.trim();
  if (root) {
    for (const candidate of [
      [".venv", "bin", "python"],
      [".venv", "Scripts", "python.exe"],
      ["venv", "bin", "python"],
      ["venv", "Scripts", "python.exe"],
    ]) {
      const full = path.join(root, ...candidate);
      if (fs.existsSync(full)) return full;
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}

interface Running {
  child: ChildProcess;
  timers: NodeJS.Timeout[];
  done: Promise<RunResult>;
}

export interface SpawnOptions {
  python: string;
  cwd: string;
  activating: boolean;
  onStderr: (chunk: string) => void;
}

export class Runner {
  private running = new Map<string, Running>();
  private activeId: string | null = null;

  get busy(): boolean {
    return this.activeId !== null;
  }

  run(id: string, args: string[], options: SpawnOptions): Promise<RunResult> {
    const started = Date.now();
    const argv = [options.python, ...args];
    const base = { id, argv, exitCode: null, signal: null, json: null, stderr: "", durationMs: 0 };
    if (this.running.has(id)) return Promise.resolve({ ...base, failure: "invalid-request", failureMessage: "Duplicate run id" });
    if (options.activating && this.activeId) {
      return Promise.resolve({ ...base, failure: "busy", failureMessage: "Another activating command is still running" });
    }
    let child: ChildProcess;
    try {
      child = spawn(options.python, args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONUTF8: "1" },
      });
    } catch (error) {
      return Promise.resolve({ ...base, failure: "spawn", failureMessage: String(error) });
    }
    if (options.activating) this.activeId = id;
    const stdout: Buffer[] = [];
    let stdoutSize = 0;
    let tooLarge = false;
    let stderr = "";
    const decoder = new StringDecoder("utf8");
    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > MAX_STDOUT) {
        tooLarge = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      const textChunk = decoder.write(chunk);
      if (!textChunk) return;
      stderr = (stderr + textChunk).slice(-STDERR_TAIL);
      options.onStderr(textChunk);
    });
    const entry: Running = { child, timers: [], done: undefined as unknown as Promise<RunResult> };
    entry.done = new Promise<RunResult>((resolve) => {
      let settled = false;
      const finish = (result: Partial<RunResult>) => {
        if (settled) return;
        settled = true;
        entry.timers.forEach(clearTimeout);
        this.running.delete(id);
        if (this.activeId === id) this.activeId = null;
        const rest = decoder.end();
        if (rest) {
          stderr = (stderr + rest).slice(-STDERR_TAIL);
          options.onStderr(rest);
        }
        resolve({ ...base, stderr, durationMs: Date.now() - started, ...result });
      };
      child.on("error", (error) => finish({ failure: "spawn", failureMessage: error.message }));
      child.on("close", (code, signal) => {
        if (tooLarge) return finish({ exitCode: code, signal, failure: "output-too-large", failureMessage: "stdout exceeded 32 MiB" });
        const json = parseOutput(Buffer.concat(stdout).toString("utf8"));
        finish(json ? { exitCode: code, signal, json } : {
          exitCode: code, signal, failure: "bad-output", failureMessage: "pymybot did not print a JSON result line",
        });
      });
    });
    this.running.set(id, entry);
    return entry.done;
  }

  // pymybot turns SIGINT/SIGTERM into a cooperative stop; escalate only if it does not exit.
  cancel(id: string): void {
    const entry = this.running.get(id);
    if (!entry || entry.timers.length) return;
    if (process.platform === "win32") {
      entry.child.kill();
      return;
    }
    entry.child.kill("SIGINT");
    entry.timers.push(
      setTimeout(() => entry.child.kill("SIGTERM"), 5000),
      setTimeout(() => entry.child.kill("SIGKILL"), 15000),
    );
  }

  async shutdown(): Promise<void> {
    const pending = [...this.running.entries()];
    for (const [id] of pending) this.cancel(id);
    await Promise.all(pending.map(([, entry]) => entry.done));
  }
}
