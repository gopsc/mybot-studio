import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Settings } from "../../shared/types";
import { buildArgs, parseOutput, resolvePython, Runner } from "../../electron/pymybot";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../../electron/settings";
import { createText, listWorkspace, readText, resolveInside, writeText } from "../../electron/workspace";

let root: string;
const settings: Settings = { ...DEFAULT_SETTINGS };

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "studio-ws-")));
  fs.mkdirSync(path.join(root, "robots"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "robots", "a.sql"), "CREATE TABLE Timer (name String);\n");
  fs.writeFileSync(path.join(root, "scripts", "a.mt"), "@Action\nt.delay;\n1;\n@\n");
  fs.writeFileSync(path.join(root, "notes.txt"), "ignored");
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("workspace guard", () => {
  it("resolves relative paths inside the root", () => {
    expect(resolveInside(root, "robots/a.sql")).toBe(path.join(root, "robots", "a.sql"));
  });

  it.each(["../x.sql", "/etc/passwd", "robots/../../x", "C:\\x.sql", "robots\\a.sql", ""])("rejects %s", (rel) => {
    expect(() => resolveInside(root, rel)).toThrow();
  });

  it("rejects symlink escapes", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "studio-out-"));
    fs.symlinkSync(outside, path.join(root, "link"));
    try {
      expect(() => resolveInside(root, "link/x.sql")).toThrow(/escapes/);
    } finally {
      fs.unlinkSync(path.join(root, "link"));
      fs.rmSync(outside, { recursive: true });
    }
  });

  it("lists only script files and their directories", () => {
    const paths = listWorkspace(root).entries.map((e) => e.path);
    expect(paths).toEqual(["robots", "robots/a.sql", "scripts", "scripts/a.mt"]);
  });

  it("writes existing files, creates new ones exclusively and limits extensions", () => {
    writeText(root, "scripts/a.mt", "@Action\n@\n");
    expect(readText(root, "scripts/a.mt")).toBe("@Action\n@\n");
    createText(root, "scripts/b.mt", "x");
    expect(() => createText(root, "scripts/b.mt", "y")).toThrow();
    expect(() => writeText(root, "notes.txt", "x")).toThrow(/can be written/);
    expect(() => writeText(root, "scripts/missing.mt", "x")).toThrow();
  });
});

describe("argv builder", () => {
  it("uses --opt=value so leading dashes stay values", () => {
    const args = buildArgs({ command: "query", robot: "robots/a.sql", sql: "-- c\nSHOW TABLES;" }, { root, settings });
    expect(args).toEqual(["-m", "pymybot", "query", `--robot=${path.join(root, "robots/a.sql")}`, "--sql=-- c\nSHOW TABLES;"]);
  });

  it("builds run with vars, settings paths and hardware flag", () => {
    const args = buildArgs(
      { command: "run", robot: "robots/a.sql", input: "scripts/a.mt", timeout: 10, allowHardware: true, vars: { level: "2" } },
      { root, settings: { ...settings, modulePaths: ["modules", "/opt/base"], cameraSrcDir: "imgs" } },
    );
    expect(args).toEqual([
      "-m", "pymybot", "run", `--robot=${path.join(root, "robots/a.sql")}`,
      `--module-path=${path.join(root, "modules")}`, "--module-path=/opt/base", `--camera-src-dir=${path.join(root, "imgs")}`,
      `--input=${path.join(root, "scripts/a.mt")}`, "--timeout=10", "--var=level=2", "--allow-hardware",
    ]);
  });

  it("builds agent args without ever passing a key", () => {
    const args = buildArgs(
      {
        command: "agent", robot: "robots/a.sql", task: "列出硬件", timeout: 60, allowHardware: false, allowActions: true,
        readVars: ["cl0"], cameraVars: [], maxRequests: 8, maxToolCalls: 16,
      },
      { root, settings: { ...settings, model: "openai-chat:qwen", baseUrl: "http://127.0.0.1:8000/v1", apiKeyEnv: "MY_KEY" } },
    );
    expect(args).toContain("--task=列出硬件");
    expect(args).toContain(`--scripts-dir=${path.join(root, "scripts")}`);
    expect(args).toContain("--read-var=cl0");
    expect(args).toContain("--api-key-env=MY_KEY");
    expect(args).toContain("--allow-actions");
    expect(args).not.toContain("--allow-hardware");
  });

  it.each([
    [{ command: "run", robot: "../x.sql", input: "scripts/a.mt", timeout: 1, allowHardware: false, vars: {} }],
    [{ command: "run", robot: "robots/a.sql", input: "scripts/a.mt", timeout: 0, allowHardware: false, vars: {} }],
    [{ command: "run", robot: "robots/a.sql", input: "scripts/a.mt", timeout: 1, allowHardware: false, vars: { "a b": "1" } }],
    [{ command: "sample", robot: "robots/a.sql", name: "-x", count: 1, intervalMs: 0, timeout: 1, allowHardware: false }],
    [{ command: "sample", robot: "robots/a.sql", name: "x", count: 1001, intervalMs: 0, timeout: 1, allowHardware: false }],
    [{ command: "query", robot: "robots/a.sql", sql: "  " }],
    [{ command: "run", robot: "robots/a.sql", input: "scripts/a.mt", timeout: 1, allowHardware: "yes", vars: {} }],
    [{ command: "shell", robot: "robots/a.sql" }],
  ])("rejects invalid request %#", (request) => {
    expect(() => buildArgs(request as never, { root, settings })).toThrow();
  });
});

describe("output and settings parsing", () => {
  it("takes the last non-empty stdout line", () => {
    expect(parseOutput('noise\n{"ok":true,"command":"check"}\n\n')).toEqual({ ok: true, command: "check" });
    expect(parseOutput('{"ok":false,"error":{"type":"X","message":"m"}}')).toMatchObject({ ok: false });
    expect(parseOutput("")).toBeNull();
    expect(parseOutput('{"ok":false}')).toBeNull();
    expect(parseOutput("[1]")).toBeNull();
  });

  it("sanitizes stored settings", () => {
    expect(sanitizeSettings({ python: 1, modulePaths: ["a", 2, ""], apiKeyEnv: "bad name" })).toEqual({
      ...DEFAULT_SETTINGS, modulePaths: ["a"],
    });
  });

  it("prefers an explicit interpreter, then the workspace venv", () => {
    expect(resolvePython(root, { ...settings, python: "/x/python" })).toBe("/x/python");
    expect(resolvePython(root, settings)).toBe(process.platform === "win32" ? "python" : "python3");
  });
});

const repo = process.env.PYMYBOT_REPO ?? path.resolve(__dirname, "../../../pymybot");
const python = [path.join(repo, ".venv", "bin", "python"), path.join(repo, ".venv", "Scripts", "python.exe")].find((p) => fs.existsSync(p));

describe.skipIf(!python)("against a real pymybot", () => {
  const ctx = () => ({ root: repo, settings });
  const exec = (id: string, request: Parameters<typeof buildArgs>[0], runner = new Runner(), onStderr = (_: string) => {}) =>
    runner.run(id, buildArgs(request, ctx()), { python: python!, cwd: repo, activating: request.command !== "check", onStderr });

  it("checks, lists hardware and queries", async () => {
    const check = await exec("c", { command: "check", robot: "robots/relay-test.sql", input: "scripts/relay-test.mt" });
    expect(check.exitCode).toBe(0);
    expect(check.json).toMatchObject({ ok: true, valid: true, action_blocks: ["Action"] });
    const hw = await exec("h", { command: "hardware", robot: "robots/relay-test.sql" });
    expect((hw.json as any).hardware.map((h: any) => h.name)).toEqual(["timer-0", "relay0"]);
    const q = await exec("q", { command: "query", robot: "robots/relay-test.sql", sql: "SHOW TABLES;" });
    expect((q.json as any).output).toContain("SHOW TABLES (2)");
  });

  it("reports script errors as structured JSON with exit code 1", async () => {
    const result = await exec("e", { command: "query", robot: "robots/relay-test.sql", sql: "SHOW TABLES" });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ ok: false, error: { message: expect.stringContaining("unexpected end") } });
    expect(result.stderr).toContain("pymybot:");
  });

  it("runs an action script and samples a virtual daemon", async () => {
    const run = await exec("r", { command: "run", robot: "robots/relay-test.sql", input: "scripts/relay-test.mt", timeout: 10, allowHardware: false, vars: {} });
    expect(run.json).toMatchObject({ ok: true, outputs: [{ result: "OK" }] });
    const sample = await exec("s", {
      command: "sample", robot: "tests/fixtures/virt/bh1750_virt.sql", name: "cl0", count: 3, intervalMs: 20, timeout: 10, allowHardware: false,
    });
    expect((sample.json as any).samples).toHaveLength(3);
    expect(typeof (sample.json as any).samples[0].v0).toBe("number");
  });

  it("serializes activating commands and cancels cooperatively", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "studio-long-")));
    try {
      fs.copyFileSync(path.join(repo, "tests/fixtures/virt/bh1750_virt.sql"), path.join(dir, "bh.sql"));
      fs.writeFileSync(path.join(dir, "long.mt"), "@Action\nt0.delay;\n 20000;\n@\n");
      const runner = new Runner();
      let stderr = "";
      const long = runner.run("long", buildArgs(
        { command: "run", robot: "bh.sql", input: "long.mt", timeout: 60, allowHardware: false, vars: {} }, { root: dir, settings }),
        { python: python!, cwd: dir, activating: true, onStderr: (chunk) => (stderr += chunk) });
      const busy = await exec("other", { command: "run", robot: "robots/relay-test.sql", input: "scripts/relay-test.mt", timeout: 10, allowHardware: false, vars: {} }, runner);
      expect(busy.failure).toBe("busy");
      await new Promise((r) => setTimeout(r, 1500));
      runner.cancel("long");
      const result = await long;
      expect(result.json).toMatchObject({ ok: false, error: { message: expect.stringContaining("Stop requested") } });
      expect(result.durationMs).toBeLessThan(10000);
      expect(stderr).toContain("VIRTUAL");
      expect(runner.busy).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing interpreter as a spawn failure", async () => {
    const result = await new Runner().run("x", ["-m", "pymybot", "scripts"], { python: "/nonexistent/python", cwd: repo, activating: false, onStderr: () => {} });
    expect(result.failure).toBe("spawn");
  });
});
