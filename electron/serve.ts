import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ServeError, ServeRequest, ServeResult } from "../shared/types.js";
import { bool, ident, int, RequestError, seconds, settingPath, text, type BuildContext } from "./pymybot.js";
import { resolveInside } from "./workspace.js";

const MAX_LINE = 64 * 1024 * 1024;
export const EXITED = -32099;
const INTERNAL_ERROR = -32603;

export interface ServeCall {
  method: string;
  params: Record<string, unknown>;
}

function locations({ root, settings }: BuildContext) {
  const modulePaths = settings.modulePaths.map((dir) => dir.trim()).filter(Boolean).map((dir) => settingPath(root, dir));
  const camera = settings.cameraSrcDir.trim();
  return { ...(modulePaths.length ? { modulePaths } : {}), ...(camera ? { cameraSrcDir: settingPath(root, camera) } : {}) };
}

function names(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new RequestError(`Invalid ${what}`);
  return value.map((name) => ident(name, what));
}

// Turns a renderer request into server params, resolving every path inside the workspace.
export function buildServeCall(request: ServeRequest, ctx: BuildContext): ServeCall {
  const { root, settings } = ctx;
  switch (request.method) {
    case "session.status":
    case "session.deactivate":
    case "agent.reset":
      return { method: request.method, params: {} };
    case "session.activate":
      return {
        method: request.method,
        params: {
          robot: resolveInside(root, text(request.robot, "robot path")),
          ...locations(ctx),
          allowHardware: bool(request.allowHardware, "allowHardware"),
        },
      };
    case "run": {
      const vars: Record<string, string> = {};
      const entries = Object.entries(request.vars ?? {});
      if (entries.length > 256) throw new RequestError("Too many variables");
      for (const [name, value] of entries) {
        if (typeof value !== "string" || value.includes("\0")) throw new RequestError(`Invalid value for ${name}`);
        vars[ident(name, "variable name")] = value;
      }
      return {
        method: "run",
        params: { input: resolveInside(root, text(request.input, "script path")), timeout: seconds(request.timeout), vars },
      };
    }
    case "apply-sql":
      return { method: "apply-sql", params: { sql: text(request.sql, "SQL") } };
    case "sample":
      return {
        method: "sample",
        params: {
          name: ident(request.name, "variable name"),
          count: int(request.count, 1, 1_000_000, "Count"),
          intervalMs: int(request.intervalMs, 0, 60000, "Interval"),
        },
      };
    case "agent.ask": {
      const scripts = path.join(root, "scripts");
      const optional = (value: string, key: string) => (value.trim() ? { [key]: value.trim() } : {});
      return {
        method: "agent.ask",
        params: {
          task: text(request.task, "task", 16 * 1024),
          robot: resolveInside(root, text(request.robot, "robot path")),
          ...locations(ctx),
          scriptsDir: fs.existsSync(scripts) ? scripts : root,
          ...optional(settings.model, "model"),
          ...optional(settings.baseUrl, "baseUrl"),
          ...optional(settings.apiKeyEnv, "apiKeyEnv"),
          readVars: names(request.readVars ?? [], "read variable"),
          cameraVars: names(request.cameraVars ?? [], "camera variable"),
          allowActions: bool(request.allowActions, "allowActions"),
          allowHardware: bool(request.allowHardware, "allowHardware"),
          timeout: seconds(request.timeout),
          maxRequests: int(request.maxRequests, 1, 100, "Max requests"),
          maxToolCalls: int(request.maxToolCalls, 1, 1000, "Max tool calls"),
        },
      };
    }
    default:
      throw new RequestError(`Unknown method: ${(request as { method: unknown }).method}`);
  }
}

export interface ServeHooks {
  onNotify(method: string, params: any): void;
  // Server-initiated request; the signal aborts when the server withdraws it.
  onRequest(method: string, params: any, signal: AbortSignal): Promise<unknown>;
  onStderr(chunk: string): void;
  onExit(code: number | null, signal: string | null): void;
}

export class ServeClient {
  private child: ChildProcess;
  private pending = new Map<string, (result: ServeResult) => void>();
  private incoming = new Map<string, AbortController>();
  private seq = 0;
  private exited: Promise<void>;
  alive = true;

  constructor(command: string, args: string[], cwd: string, private hooks: ServeHooks) {
    this.child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONUTF8: "1" },
    });
    const out = new StringDecoder("utf8");
    const err = new StringDecoder("utf8");
    let buffer = "";
    this.child.stdout!.on("data", (chunk: Buffer) => {
      buffer += out.write(chunk);
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        this.receive(line);
      }
      if (buffer.length > MAX_LINE) {
        hooks.onStderr("studio: pymybot serve sent an oversized line; stopping it\n");
        this.child.kill("SIGKILL");
      }
    });
    this.child.stderr!.on("data", (chunk: Buffer) => {
      const textChunk = err.write(chunk);
      if (textChunk) hooks.onStderr(textChunk);
    });
    this.child.stdin!.on("error", () => {});
    this.exited = new Promise((resolve) => {
      let done = false;
      const finish = (code: number | null, signal: string | null, message: string) => {
        if (done) return;
        done = true;
        this.alive = false;
        for (const settle of this.pending.values()) settle({ ok: false, failure: "exited", error: { code: EXITED, message } });
        this.pending.clear();
        for (const controller of this.incoming.values()) controller.abort();
        this.incoming.clear();
        hooks.onExit(code, signal);
        resolve();
      };
      this.child.on("error", (error) => finish(null, null, `Cannot start pymybot serve: ${error.message}`));
      this.child.on("close", (code, signal) => finish(code, signal, `pymybot serve exited (${signal ?? code})`));
    });
  }

  private write(message: object) {
    if (!this.alive || !this.child.stdin!.writable) return false;
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    return true;
  }

  private receive(line: string) {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    // The CLI's final result line has no jsonrpc member.
    if (typeof message !== "object" || message === null || message.jsonrpc !== "2.0") return;
    const { id, method, params } = message;
    if (typeof method === "string") {
      if (id === undefined || id === null) {
        if (method === "cancel") this.incoming.get(params?.id)?.abort();
        else this.hooks.onNotify(method, params);
        return;
      }
      void this.answer(id, method, params);
      return;
    }
    const settle = this.pending.get(id);
    if (!settle) return;
    this.pending.delete(id);
    if ("error" in message) {
      const error = message.error as ServeError;
      settle({ ok: false, error: { code: error?.code ?? INTERNAL_ERROR, message: String(error?.message ?? "Unknown error"), data: error?.data } });
    } else settle({ ok: true, result: message.result });
  }

  private async answer(id: string | number, method: string, params: unknown) {
    const controller = new AbortController();
    this.incoming.set(String(id), controller);
    try {
      this.write({ id, result: await this.hooks.onRequest(method, params, controller.signal) });
    } catch (error) {
      this.write({ id, error: { code: INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) } });
    } finally {
      this.incoming.delete(String(id));
    }
  }

  request(method: string, params: object = {}, id = `c${++this.seq}`): Promise<ServeResult> {
    if (this.pending.has(id)) {
      return Promise.resolve({ ok: false, failure: "invalid-request", error: { code: -32600, message: "Duplicate request id" } });
    }
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      if (!this.write({ id, method, params })) {
        this.pending.delete(id);
        resolve({ ok: false, failure: "exited", error: { code: EXITED, message: "pymybot serve is not running" } });
      }
    });
  }

  cancel(id: string) {
    if (this.pending.has(id)) this.write({ method: "cancel", params: { id } });
  }

  // The server cancels work and cleans up drivers on EOF; signals are only a fallback.
  async stop(graceMs = 40000): Promise<void> {
    if (this.alive) {
      void this.request("shutdown");
      this.child.stdin!.end();
      const timers = [
        setTimeout(() => this.child.kill("SIGTERM"), graceMs),
        setTimeout(() => this.child.kill("SIGKILL"), graceMs + 5000),
      ];
      await this.exited;
      timers.forEach(clearTimeout);
    }
    await this.exited;
  }
}
