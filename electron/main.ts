import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { PymybotRequest, RunResult, Settings, WorkspaceInfo } from "../shared/types.js";
import { ACTIVATING, buildArgs, RequestError, resolvePython, Runner } from "./pymybot.js";
import { sanitizeSettings, SettingsStore } from "./settings.js";
import { createText, listWorkspace, readText, writeText } from "./workspace.js";

if (process.env.PYMYBOT_STUDIO_USER_DATA) app.setPath("userData", process.env.PYMYBOT_STUDIO_USER_DATA);

const devServer = process.env.VITE_DEV_SERVER_URL;
const runner = new Runner();
let store: SettingsStore;
let win: BrowserWindow | null = null;
let root: string | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "pymybot Studio",
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
  root = info.root;
  store.update({ lastWorkspace: root });
  return info;
}

// Physical-device access and agent preapproval are confirmed here, out of the renderer's reach.
async function confirmRisk(request: PymybotRequest): Promise<boolean> {
  const risks: string[] = [];
  if ("allowHardware" in request && request.allowHardware) risks.push("--allow-hardware：打开物理设备，激活本身就可能写硬件。");
  if (request.command === "agent" && request.allowActions) risks.push("--allow-actions：预授权智能体执行脚本、读取变量和拍照，不再逐次确认。");
  if (!risks.length || !win) return true;
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["取消", "继续执行"],
    defaultId: 0,
    cancelId: 0,
    title: "确认执行",
    message: `即将以以下权限运行 pymybot ${request.command}`,
    detail: `${risks.join("\n")}\n\n只对已审阅的可信脚本和驱动授权。`,
  });
  return response === 1;
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
  if (!(await confirmRisk(request))) return { ...base, argv: [python, ...args], failure: "declined", failureMessage: "Cancelled by user" };
  return runner.run(id, args, {
    python,
    cwd: workspace,
    activating,
    onStderr: (chunk) => win?.webContents.send("pymybot:stderr", { id, chunk }),
  });
}

app.whenReady().then(() => {
  store = new SettingsStore(path.join(app.getPath("userData"), "settings.json"));
  const preset = process.env.PYMYBOT_STUDIO_WORKSPACE || store.lastWorkspace;
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
  void runner.shutdown().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
