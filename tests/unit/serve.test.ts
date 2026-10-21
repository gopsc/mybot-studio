import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Settings } from "../../shared/types";
import { DEFAULT_SETTINGS } from "../../electron/settings";
import { buildServeCall, EXITED, ServeClient, type ServeHooks } from "../../electron/serve";

let root: string;
const settings: Settings = { ...DEFAULT_SETTINGS };

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "studio-serve-")));
  fs.mkdirSync(path.join(root, "robots"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "robots", "a.sql"), "");
  fs.writeFileSync(path.join(root, "scripts", "a.mt"), "");
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("serve call builder", () => {
  it("resolves workspace paths and settings locations", () => {
    const call = buildServeCall({ method: "session.activate", robot: "robots/a.sql", allowHardware: false },
      { root, settings: { ...settings, modulePaths: ["mods", " "], cameraSrcDir: "/srv/cam" } });
    expect(call).toEqual({
      method: "session.activate",
      params: { robot: path.join(root, "robots", "a.sql"), modulePaths: [path.join(root, "mods")], cameraSrcDir: "/srv/cam", allowHardware: false },
    });
    expect(buildServeCall({ method: "run", input: "scripts/a.mt", timeout: 5, vars: { speed: "-1" } }, { root, settings }).params)
      .toEqual({ input: path.join(root, "scripts", "a.mt"), timeout: 5, vars: { speed: "-1" } });
  });

  it.each([
    { method: "session.activate", robot: "../x.sql", allowHardware: false },
    { method: "run", input: "/etc/passwd", timeout: 5, vars: {} },
    { method: "run", input: "scripts/a.mt", timeout: 0, vars: {} },
    { method: "run", input: "scripts/a.mt", timeout: 5, vars: { "bad name": "1" } },
    { method: "sample", name: "../x", count: 1, intervalMs: 0 },
    { method: "sample", name: "x", count: 2_000_000, intervalMs: 0 },
    { method: "apply-sql", sql: " " },
    { method: "nope" },
  ])("rejects %j", (request) => {
    expect(() => buildServeCall(request as any, { root, settings })).toThrow();
  });

  it("builds agent params from settings without ever carrying a key", () => {
    const call = buildServeCall({
      method: "agent.ask", task: "看看", robot: "robots/a.sql", timeout: 60, allowHardware: false, allowActions: true,
      readVars: ["t0"], cameraVars: [], maxRequests: 8, maxToolCalls: 16,
    }, { root, settings: { ...settings, model: "openai:local", baseUrl: "http://127.0.0.1:8000/v1", apiKeyEnv: "LOCAL_KEY" } });
    expect(call.params).toMatchObject({
      task: "看看", robot: path.join(root, "robots", "a.sql"), scriptsDir: path.join(root, "scripts"),
      model: "openai:local", baseUrl: "http://127.0.0.1:8000/v1", apiKeyEnv: "LOCAL_KEY", readVars: ["t0"], allowActions: true,
    });
    expect(JSON.stringify(call.params)).not.toMatch(/sk-|apiKey"/);
  });
});

const FAKE_SERVER = String.raw`
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
process.stdout.write("not json\n" + JSON.stringify({ ok: true }) + "\n");
const waiting = {};
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "echo") send({ id: m.id, result: m.params });
  else if (m.method === "fail") send({ id: m.id, error: { code: -32000, message: "boom", data: { type: "X" } } });
  else if (m.method === "ask") { waiting.s1 = m.id; send({ id: "s1", method: "confirm", params: { tool: "run_action_script" } }); }
  else if (m.method === "withdraw") { waiting.s2 = m.id; send({ id: "s2", method: "confirm", params: {} }); send({ method: "cancel", params: { id: "s2" } }); }
  else if (m.method === "die") process.exit(3);
  else if (m.method === "shutdown") send({ id: m.id, result: {} });
  else if (m.id in waiting) send({ id: waiting[m.id], result: m.result ?? m.error });
});
`;

function hooks(overrides: Partial<ServeHooks> = {}) {
  const log = { notes: [] as unknown[], stderr: "", exits: [] as unknown[] };
  const value: ServeHooks = {
    onNotify: (method, params) => log.notes.push({ method, params }),
    onRequest: async () => ({ approved: true }),
    onStderr: (chunk) => (log.stderr += chunk),
    onExit: (code, signal) => log.exits.push({ code, signal }),
    ...overrides,
  };
  return { log, value };
}

describe("serve client transport", () => {
  it("correlates replies, ignores non-protocol lines and answers server requests", async () => {
    const seen: unknown[] = [];
    const { log, value } = hooks({ onRequest: async (method, params) => (seen.push({ method, params }), { approved: true }) });
    const client = new ServeClient(process.execPath, ["-e", FAKE_SERVER], root, value);
    expect(await client.request("echo", { a: 1 }, "r:1")).toEqual({ ok: true, result: { a: 1 } });
    expect(await client.request("fail")).toEqual({ ok: false, error: { code: -32000, message: "boom", data: { type: "X" } } });
    expect(await client.request("ask")).toEqual({ ok: true, result: { approved: true } });
    expect(seen).toEqual([{ method: "confirm", params: { tool: "run_action_script" } }]);
    await client.stop();
    expect(client.alive).toBe(false);
    expect(log.exits).toHaveLength(1);
  });

  it("aborts a server request the server withdraws", async () => {
    const { value } = hooks({
      onRequest: (_method, _params, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ withdrawn: true }))),
    });
    const client = new ServeClient(process.execPath, ["-e", FAKE_SERVER], root, value);
    expect(await client.request("withdraw")).toEqual({ ok: true, result: { withdrawn: true } });
    await client.stop();
  });

  it("fails pending requests when the process exits and refuses new ones", async () => {
    const { log, value } = hooks();
    const client = new ServeClient(process.execPath, ["-e", FAKE_SERVER], root, value);
    const result = await client.request("die");
    expect(result).toMatchObject({ ok: false, failure: "exited", error: { code: EXITED } });
    expect(log.exits).toEqual([{ code: 3, signal: null }]);
    expect(await client.request("echo")).toMatchObject({ ok: false, failure: "exited" });
  });

  it("reports a missing interpreter as an exit", async () => {
    const { log, value } = hooks();
    const client = new ServeClient("/nonexistent/python", [], root, value);
    expect(await client.request("initialize")).toMatchObject({ ok: false, failure: "exited", error: { message: expect.stringContaining("Cannot start") } });
    expect(log.exits).toHaveLength(1);
  });
});

const repo = process.env.PYMYBOT_REPO ?? path.resolve(__dirname, "../../../pymybot");
const python = [path.join(repo, ".venv", "bin", "python"), path.join(repo, ".venv", "Scripts", "python.exe")].find((p) => fs.existsSync(p));

describe.skipIf(!python)("against a real pymybot serve", () => {
  const ctx = () => ({ root: repo, settings });

  it("keeps one session across runs and hot SQL, then deactivates", async () => {
    const { log, value } = hooks();
    const client = new ServeClient(python!, ["-m", "pymybot", "serve"], repo, value);
    try {
      expect((await client.request("initialize")).ok).toBe(true);
      const call = (request: Parameters<typeof buildServeCall>[0]) => {
        const { method, params } = buildServeCall(request, ctx());
        return client.request(method, params);
      };
      const active = await call({ method: "session.activate", robot: "robots/relay-test.sql", allowHardware: false });
      expect(active).toMatchObject({ ok: true, result: { state: "Active" } });
      for (let i = 0; i < 2; i++) {
        expect(await call({ method: "run", input: "scripts/relay-test.mt", timeout: 10, vars: {} }))
          .toMatchObject({ ok: true, result: { outputs: [{ result: "OK" }] } });
      }
      const hot = await call({ method: "apply-sql", sql: "INSERT INTO Timer (name) VALUES ('timer-1');" });
      expect(hot.ok && hot.result.hardware.map((h: any) => h.name)).toEqual(["timer-0", "timer-1", "relay0"]);
      expect(await call({ method: "apply-sql", sql: "INSERT INTO Timer (name) VALUES ('timer-1');" })).toMatchObject({ ok: false });
      expect(await call({ method: "session.deactivate" })).toMatchObject({ ok: true, result: { state: "Inactive" } });
      const states = log.notes.filter((n: any) => n.method === "session").map((n: any) => n.params.state);
      expect(states).toEqual(["Active", "Inactive"]);
    } finally {
      await client.stop();
    }
  });

  it("streams samples and cancels an endless stream without stopping the session", async () => {
    const samples: any[] = [];
    const { value } = hooks({ onNotify: (method, params) => method === "sample" && samples.push(params) });
    const client = new ServeClient(python!, ["-m", "pymybot", "serve"], repo, value);
    try {
      const activate = buildServeCall({ method: "session.activate", robot: "tests/fixtures/virt/bh1750_virt.sql", allowHardware: false }, ctx());
      expect((await client.request(activate.method, activate.params)).ok).toBe(true);
      const sample = buildServeCall({ method: "sample", name: "cl0", count: 1_000_000, intervalMs: 10 }, ctx());
      const endless = client.request(sample.method, sample.params, "r:s");
      while (samples.length < 5) await new Promise((r) => setTimeout(r, 20));
      client.cancel("r:s");
      expect(await endless).toMatchObject({ ok: false, error: { code: -32800 } });
      expect(samples[0]).toMatchObject({ id: "r:s", index: 0, value: { result: "OK" } });
      expect(typeof samples[0].value.v0).toBe("number");
      const again = buildServeCall({ method: "sample", name: "cl0", count: 2, intervalMs: 0 }, ctx());
      expect(await client.request(again.method, again.params)).toEqual({ ok: true, result: { name: "cl0", count: 2 } });
    } finally {
      await client.stop();
    }
  });
});
