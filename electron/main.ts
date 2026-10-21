import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { PymybotRequest, RunResult, ServeEvent, ServeRequest, ServeResult, SessionStatus, Settings, WorkspaceInfo } from "../shared/types.js";
import { ACTIVATING, buildArgs, RequestError, resolvePython, Runner } from "./pymybot.js";
import { buildServeCall, ServeClient } from "./serve.js";
import { sanitizeSettings, SettingsStore } from "./settings.js";
import { createText, listWorkspace, readText, writeText } from "./workspace.js";

if (process.env.MYBOT_STUDIO_USER_DATA) app.setPath("userData", process.env.MYBOT_STUDIO_USER_DATA);

const devServer = process.env.VITE_DEV_SERVER_URL;
const runner = new Runner();
let store: SettingsStore;
let win: BrowserWindow | null = null;
let root: string | null = null;
const INACTIVE: SessionStatus = { state: "Inactive", busy: null, agent: false };
let serve: { client: ServeClient; key: string; ready: Promise<ServeResult> } | null = null;
let serveStatus: SessionStatus = INACTIVE;
// Agent configuration whose risky flags the user already approved for the open conversation.
let confirmedAgent: string | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "mybot Studio",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  if (devServer) void win.loadURL(devServer);
  else void win.loadFile(path.join(__dirname, "..", "..", "dist", "index.html"));
  win.on("closed", () => {
    win = null;
  });
}

function handle<T>(channel: string, fn: (...args: any[]) => T | Promise<T>) {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error("Rejected IPC from an unexpected frame");
    }
    return fn(...args);
  });
}

function requireRoot(): string {
  if (!root) throw new Error("No workspace is open");
  return root;
}

function setRoot(dir: string): WorkspaceInfo {
  const info = listWorkspace(dir);
  if (root !== info.root) void stopServe();
  root = info.root;
  store.update({ lastWorkspace: root });
  return info;
}

// Physical-device access and agent preapproval are confirmed here, out of the renderer's reach.
async function confirmRisks(what: string, risks: string[]): Promise<boolean> {
  if (!risks.length || !win) return true;
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["取消", "继续执行"],
    defaultId: 0,
    cancelId: 0,
    title: "确认执行",
    message: `即将以以下权限运行 pymybot ${what}`,
    detail: `${risks.join("\n")}\n\n只对已审阅的可信脚本和驱动授权。`,
  });
  return response === 1;
}

const HARDWARE_RISK = "--allow-hardware：打开物理设备，激活本身就可能写硬件。";
const ACTIONS_RISK = "--allow-actions：预授权智能体执行脚本、读取变量和拍照，不再逐次确认。";

function confirmRisk(request: PymybotRequest): Promise<boolean> {
  const risks: string[] = [];
  if ("allowHardware" in request && request.allowHardware) risks.push(HARDWARE_RISK);
  if (request.command === "agent" && request.allowActions) risks.push(ACTIONS_RISK);
  return confirmRisks(request.command, risks);
}

async function runPymybot(id: string, request: PymybotRequest): Promise<RunResult> {
  const workspace = requireRoot();
  const settings = store.settings;
  const python = resolvePython(workspace, settings);
  const base = { id, argv: [python], exitCode: null, signal: null, json: null, stderr: "", durationMs: 0 };
  if (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id)) return { ...base, failure: "invalid-request", failureMessage: "Invalid run id" };
  let args: string[];
  try {
    args = buildArgs(request, { root: workspace, settings });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, failure: "invalid-request", failureMessage: error instanceof RequestError ? message : `Invalid request: ${message}` };
  }
  const activating = ACTIVATING.has(request.command);
  if (activating && runner.busy) {
    return { ...base, argv: [python, ...args], failure: "busy", failureMessage: "Another activating command is still running" };
  }
  if (activating && (serveStatus.state === "Active" || serveStatus.agent)) {
    return { ...base, argv: [python, ...args], failure: "busy", failureMessage: "A Studio session owns the robot; end it first" };
  }
  if (!(await confirmRisk(request))) return { ...base, argv: [python, ...args], failure: "declined", failureMessage: "Cancelled by user" };
  return runner.run(id, args, {
    python,
    cwd: workspace,
    activating,
    onStderr: (chunk) => win?.webContents.send("pymybot:stderr", { id, chunk }),
  });
}

function emit(event: ServeEvent) {
  win?.webContents.send("serve:event", event);
}

const RENDERER_ID = /^r:/;

async function confirmTool(params: any, signal: AbortSignal): Promise<{ approved: boolean }> {
  const tool = typeof params?.tool === "string" ? params.tool : "?";
  const args = JSON.stringify(params?.arguments ?? {}, null, 2) ?? "";
  let approved = false;
  // Anything too long to review in a dialog is denied rather than truncated.
  if (win && args.length <= 4000 && !signal.aborted) {
    const { response } = await dialog.showMessageBox(win, {
      signal,
      type: "question",
      buttons: ["拒绝", "批准"],
      defaultId: 0,
      cancelId: 0,
      title: "智能体请求执行工具",
      message: `智能体请求调用 ${tool}`,
      detail: args,
    });
    approved = response === 1 && !signal.aborted;
  }
  emit({ type: "confirm", tool, arguments: params?.arguments, approved });
  return { approved };
}

function startServe(python: string, workspace: string) {
  const client: ServeClient = new ServeClient(python, ["-m", "pymybot", "serve"], workspace, {
    onNotify(method, params) {
      if (method === "session") {
        serveStatus = params as SessionStatus;
        if (!serveStatus.agent) confirmedAgent = null;
        emit({ type: "session", status: serveStatus });
      } else if (method === "sample" && typeof params?.id === "string") {
        emit({ type: "sample", id: params.id.replace(RENDERER_ID, ""), index: params.index, value: params.value, t: params.t });
      } else if (method === "agent.event" && typeof params?.id === "string") {
        emit({ type: "agent", id: params.id.replace(RENDERER_ID, ""), event: params.event });
      }
    },
    async onRequest(method, params, signal) {
      if (method !== "confirm") throw new Error(`Unsupported client method: ${method}`);
      return confirmTool(params, signal);
    },
    onStderr: (chunk) => emit({ type: "stderr", chunk }),
    onExit(code, signal) {
      if (serve?.client === client) serve = null;
      serveStatus = INACTIVE;
      confirmedAgent = null;
      emit({ type: "session", status: INACTIVE });
      emit({ type: "exit", code, signal });
    },
  });
  return { client, key: `${python}\0${workspace}`, ready: client.request("initialize") };
}

async function stopServe() {
  const current = serve;
  serve = null;
  if (current) await current.client.stop();
}

async function getServe(): Promise<ServeClient | ServeResult> {
  const workspace = requireRoot();
  const python = resolvePython(workspace, store.settings);
  if (serve && serve.key !== `${python}\0${workspace}`) await stopServe();
  if (!serve) serve = startServe(python, workspace);
  const ready = await serve.ready;
  if (!ready.ok) return { ...ready, failure: "spawn" };
  return serve.client;
}

async function callServe(id: string, request: ServeRequest): Promise<ServeResult> {
  const invalid = (message: string): ServeResult => ({ ok: false, failure: "invalid-request", error: { code: -32602, message } });
  if (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id)) return invalid("Invalid request id");
  let call;
  try {
    call = buildServeCall(request, { root: requireRoot(), settings: store.settings });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return invalid(error instanceof RequestError ? message : `Invalid request: ${message}`);
  }
  const owning = call.method === "session.activate" || call.method === "agent.ask";
  if (owning && runner.busy) return { ok: false, error: { code: -32001, message: "A CLI command is still using the robot" } };
  const declined: ServeResult = { ok: false, failure: "declined", error: { code: -32800, message: "Cancelled by user" } };
  if (call.method === "session.activate" && call.params.allowHardware && !(await confirmRisks("serve 会话", [HARDWARE_RISK]))) {
    return declined;
  }
  let agentKey: string | null = null;
  if (call.method === "agent.ask") {
    const { task: _task, ...config } = call.params;
    agentKey = JSON.stringify(config);
    const risks = [...(config.allowHardware ? [HARDWARE_RISK] : []), ...(config.allowActions ? [ACTIONS_RISK] : [])];
    if (risks.length && confirmedAgent !== agentKey && !(await confirmRisks("智能体", risks))) return declined;
  }
  const client = await getServe();
  if (!(client instanceof ServeClient)) return client;
  if (agentKey) confirmedAgent = agentKey;
  const result = await client.request(call.method, call.params, `r:${id}`);
  // Notifications precede the reply on the same stream, so serveStatus is current here.
  if (agentKey && !serveStatus.agent) confirmedAgent = null;
  return result;
}

app.whenReady().then(() => {
  store = new SettingsStore(path.join(app.getPath("userData"), "settings.json"));
  const preset = process.env.MYBOT_STUDIO_WORKSPACE || store.lastWorkspace;
  if (preset && fs.existsSync(preset)) {
    try {
      setRoot(preset);
    } catch {
      root = null;
    }
  }

  handle("workspace:open", async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "打开 pymybot 工作区" });
    return result.canceled || !result.filePaths[0] ? null : setRoot(result.filePaths[0]);
  });
  handle("workspace:current", () => (root ? listWorkspace(root) : null));
  handle("workspace:refresh", () => (root ? listWorkspace(root) : null));
  handle("file:read", (rel: string) => readText(requireRoot(), rel));
  handle("file:write", (rel: string, content: string) => writeText(requireRoot(), rel, content));
  handle("file:create", (rel: string, content: string) => createText(requireRoot(), rel, content));
  handle("settings:get", () => store.settings);
  handle("settings:set", (value: unknown): Settings => {
    store.update({ settings: sanitizeSettings(value) });
    return store.settings;
  });
  handle("python:resolve", () => resolvePython(root, store.settings));
  handle("pymybot:run", (id: string, request: PymybotRequest) => runPymybot(id, request));
  handle("pymybot:cancel", (id: string) => runner.cancel(id));
  handle("serve:call", (id: string, request: ServeRequest) => callServe(id, request));
  handle("serve:cancel", (id: string) => {
    if (typeof id === "string") serve?.client.cancel(`r:${id}`);
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void Promise.allSettled([runner.shutdown(), stopServe()]).finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
