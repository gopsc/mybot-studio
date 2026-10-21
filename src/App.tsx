import { useCallback, useEffect, useRef, useState } from "react";
import type { PymybotRequest, RunResult, ServeEvent, ServeRequest, ServeResult, SessionStatus, Settings, WorkspaceInfo } from "../shared/types";
import { Editor, type EditorHandle } from "./components/Editor";
import { FileTree } from "./components/FileTree";
import {
  AgentPanel, type CheckState, type HardwareItem, HardwarePanel, type LogEntry, LogPanel, OutputPanel, type Problem,
  ProblemsPanel, QueryPanel, type RunState, SamplePanel, type ServeCall,
} from "./components/Panels";
import { SettingsDialog } from "./components/SettingsDialog";
import { basename, cliOutcome, extname, failureText, locateError, newId, serveError, serveOutcome, studio } from "./util";

type PanelId = "problems" | "output" | "hardware" | "query" | "sample" | "agent" | "log";
const PANELS: [PanelId, string][] = [
  ["problems", "问题"], ["output", "输出"], ["hardware", "硬件"], ["query", "查询"], ["sample", "采样"], ["agent", "智能体"], ["log", "日志"],
];
const ACTIVATING = new Set(["run", "sample", "apply-sql", "agent"]);
// Serve methods that own the robot and can be cancelled.
const SERVE_WORK = new Set(["session.activate", "run", "apply-sql", "sample", "agent.ask"]);
const INACTIVE: SessionStatus = { state: "Inactive", busy: null, agent: false };

interface ActiveRun {
  id: string;
  command: string;
  kind: "cli" | "serve";
}

const robotWork = (run: ActiveRun) => (run.kind === "cli" ? ACTIVATING : SERVE_WORK).has(run.command);

const TEMPLATES: Record<string, string> = {
  ".sql": "CREATE TABLE Timer (name String);\nINSERT INTO Timer (name) VALUES ('t0');\n",
  ".mt": "@Action\nt0.delay;\n    100;\n@\n",
  ".lua": [
    "local mpath = assert(__mpath)",
    'dofile(mpath.resolve("lib/drv_common.lua"))',
    "",
    "function build(data) return {result = \"OK\"} end",
    "function call(data) return {result = \"OK\"} end",
    "function destroy(data) return {result = \"OK\"} end",
    "",
  ].join("\n"),
  ".md": "",
};

function pickDefault(entries: WorkspaceInfo["entries"], ext: string, preferredDir: string, current: string): string {
  const files = entries.filter((e) => e.kind === "file" && extname(e.path) === ext).map((e) => e.path);
  if (files.includes(current)) return current;
  return files.find((p) => p.startsWith(`${preferredDir}/`)) ?? files[0] ?? "";
}

export function App() {
  const [ws, setWs] = useState<WorkspaceInfo | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [robot, setRobot] = useState("");
  const [script, setScript] = useState("");
  const [panel, setPanel] = useState<PanelId>("problems");
  const [panelHeight, setPanelHeight] = useState(300);
  const [allowHardware, setAllowHardware] = useState(false);
  const [timeout, setTimeoutSec] = useState(30);
  const [check, setCheck] = useState<CheckState>({ running: false, summary: null, problems: [] });
  const [runState, setRunState] = useState<RunState>({ running: false, live: "", outcome: null, session: false });
  const [session, setSession] = useState<SessionStatus>(INACTIVE);
  const [serveLog, setServeLog] = useState("");
  const [hardware, setHardware] = useState<HardwareItem[]>([]);
  const [hwError, setHwError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [activeRuns, setActiveRuns] = useState<ActiveRun[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [newFile, setNewFile] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const editor = useRef<EditorHandle>(null);
  const checkSeq = useRef(0);
  const hardwareSeq = useRef(0);
  const listeners = useRef(new Map<string, (chunk: string) => void>());
  const serveListeners = useRef(new Map<string, (event: ServeEvent) => void>());
  const serveStderr = useRef<((chunk: string) => void) | null>(null);
  const live = session.state === "Active";

  useEffect(() => studio().onStderr(({ id, chunk }) => listeners.current.get(id)?.(chunk)), []);

  useEffect(() => studio().onServe((event) => {
    switch (event.type) {
      case "session":
        setSession(event.status);
        break;
      case "sample":
      case "agent":
        serveListeners.current.get(event.id)?.(event);
        break;
      case "confirm":
        serveListeners.current.forEach((listener) => listener(event));
        break;
      case "stderr":
        serveStderr.current?.(event.chunk);
        setServeLog((text) => (text + event.chunk).slice(-200000));
        break;
      case "exit":
        if (event.code !== 0) setNotice(`pymybot serve 已退出（${event.signal ?? event.code}），下次使用时自动重启`);
        break;
    }
  }), []);

  const exec = useCallback(async (request: PymybotRequest, onStderr?: (chunk: string) => void): Promise<RunResult> => {
    const id = newId();
    listeners.current.set(id, (chunk) => onStderr?.(chunk));
    setActiveRuns((runs) => [...runs, { id, command: request.command, kind: "cli" }]);
    let result: RunResult;
    try {
      result = await studio().run(id, request);
    } catch (error) {
      result = {
        id, argv: [], exitCode: null, signal: null, json: null, stderr: "", durationMs: 0,
        failure: "invalid-request", failureMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      listeners.current.delete(id);
      setActiveRuns((runs) => runs.filter((run) => run.id !== id));
    }
    setLog((entries) => [...entries.slice(-199), { at: Date.now(), kind: "cli", request, result }]);
    return result;
  }, []);

  const serveCall: ServeCall = useCallback(async (request: ServeRequest, options = {}) => {
    const id = options.id ?? newId();
    if (options.onEvent) serveListeners.current.set(id, options.onEvent);
    setActiveRuns((runs) => [...runs, { id, command: request.method, kind: "serve" }]);
    const started = Date.now();
    let result: ServeResult;
    try {
      result = await studio().serve(id, request);
    } catch (error) {
      result = { ok: false, failure: "invalid-request", error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
    } finally {
      serveListeners.current.delete(id);
      setActiveRuns((runs) => runs.filter((run) => run.id !== id));
    }
    setLog((entries) => [...entries.slice(-199), { at: started, kind: "serve", request, result, durationMs: Date.now() - started }]);
    return result;
  }, []);

  const applyWorkspace = useCallback((info: WorkspaceInfo | null) => {
    setWs(info);
    if (!info) return;
    setRobot((current) => pickDefault(info.entries, ".sql", "robots", current));
    setScript((current) => pickDefault(info.entries, ".mt", "scripts", current));
  }, []);

  useEffect(() => {
    void studio().currentWorkspace().then(applyWorkspace);
    void studio().getSettings().then(setSettings);
  }, [applyWorkspace]);

  const runCheck = useCallback(async () => {
    if (!robot) return;
    const seq = ++checkSeq.current;
    setCheck((state) => ({ ...state, running: true }));
    const result = await exec({ command: "check", robot, input: script || undefined });
    if (seq !== checkSeq.current) return;
    for (const path of [robot, script]) if (path) editor.current?.setMarkers(path, []);
    const error = failureText(result);
    if (!error && result.json?.ok) {
      const tables = (result.json.tables as string[]) ?? [];
      const blocks = result.json.action_blocks as string[] | null;
      setCheck({ running: false, problems: [], summary: `✓ 检查通过：${tables.length} 张表（${tables.join(", ")}）${blocks ? `；动作块 ${blocks.join(", ")}` : ""}` });
      return;
    }
    const location = error ? locateError(error) : null;
    const path = location ? (location.target === "robot" ? robot : script || robot) : null;
    const problem: Problem = { message: error ?? "未知错误", path, line: location?.line ?? 1, column: location?.column ?? 1 };
    if (path) editor.current?.setMarkers(path, [{ line: problem.line, column: problem.column, message: problem.message }]);
    setCheck({ running: false, problems: [problem], summary: "✗ 检查失败" });
    setPanel("problems");
  }, [exec, robot, script]);

  const refreshHardware = useCallback(async () => {
    if (!robot || live) return;
    const seq = ++hardwareSeq.current;
    const result = await exec({ command: "hardware", robot });
    if (seq !== hardwareSeq.current) return;
    const error = failureText(result);
    setHwError(error);
    setHardware(!error && result.json?.ok ? (result.json.hardware as HardwareItem[]) : []);
  }, [exec, robot, live]);

  useEffect(() => {
    if (robot) void refreshHardware();
    else setHardware([]);
  }, [robot, refreshHardware]);

  useEffect(() => {
    if (robot) void runCheck();
    // Re-check only when the selection changes; saves trigger their own check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [robot, script]);

  const openFile = useCallback(async (path: string) => {
    try {
      if (!editor.current?.has(path)) editor.current?.open(path, await studio().readFile(path));
      setTabs((list) => (list.includes(path) ? list : [...list, path]));
      setActive(path);
      if (extname(path) === ".sql") setRobot(path);
      if (extname(path) === ".mt") setScript(path);
    } catch (error) {
      setNotice(`打开失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const saveFile = useCallback(async (path: string) => {
    const text = editor.current?.text(path);
    if (text == null) return;
    try {
      await studio().writeFile(path, text);
      editor.current?.markSaved(path);
      setNotice(`已保存 ${path}`);
      if (path === robot || path === script || [".sql", ".mt"].includes(extname(path))) void runCheck();
      if (path === robot) void refreshHardware();
    } catch (error) {
      setNotice(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [robot, script, runCheck, refreshHardware]);

  const closeTab = (path: string) => {
    if (dirty.has(path) && !window.confirm(`${basename(path)} 尚未保存，确定关闭？`)) return;
    editor.current?.close(path);
    setDirty((set) => {
      const next = new Set(set);
      next.delete(path);
      return next;
    });
    setTabs((list) => {
      const next = list.filter((p) => p !== path);
      if (active === path) setActive(next[Math.max(0, list.indexOf(path) - 1)] ?? null);
      return next;
    });
  };

  const runScript = useCallback(async () => {
    if (!robot || !script) return;
    for (const path of [robot, script]) if (dirty.has(path)) await saveFile(path);
    setPanel("output");
    setRunState({ running: true, live: "", outcome: null, session: live });
    const append = (chunk: string) => setRunState((state) => ({ ...state, live: (state.live + chunk).slice(-200000) }));
    if (live) {
      // The session's stderr is not tagged per request; attribute it to the run while it lasts.
      serveStderr.current = append;
      const started = Date.now();
      try {
        const result = await serveCall({ method: "run", input: script, timeout, vars: {} });
        setRunState((state) => ({ ...state, running: false, outcome: serveOutcome(result, started) }));
      } finally {
        serveStderr.current = null;
      }
      return;
    }
    const result = await exec({ command: "run", robot, input: script, timeout, allowHardware, vars: {} }, append);
    setRunState((state) => ({ ...state, running: false, outcome: cliOutcome(result) }));
  }, [robot, script, dirty, saveFile, exec, serveCall, live, timeout, allowHardware]);

  const toggleSession = async () => {
    if (live) {
      const result = await serveCall({ method: "session.deactivate" });
      setNotice(result.ok ? "会话已结束" : `结束会话失败：${serveError(result)}`);
      return;
    }
    if (!robot) return;
    if (dirty.has(robot)) await saveFile(robot);
    const result = await serveCall({ method: "session.activate", robot, allowHardware });
    if (result.ok) {
      setHardware(result.result.hardware);
      setHwError(null);
      setNotice(`会话已激活：${robot}`);
    } else if (result.failure !== "declined") {
      setNotice(`激活失败：${serveError(result)}`);
    }
  };

  const stopAll = () => activeRuns.filter(robotWork).forEach((run) => void (run.kind === "cli" ? studio().cancel(run.id) : studio().serveCancel(run.id)));
  const activating = activeRuns.some(robotWork);
  const sessionPending = activeRuns.some((run) => run.command === "session.activate" || run.command === "session.deactivate");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "F5") {
        event.preventDefault();
        if (!activating) void runScript();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runScript, activating]);

  const openWorkspace = async () => {
    if (dirty.size && !window.confirm("有未保存的文件，切换工作区会丢弃这些修改，继续？")) return;
    const info = await studio().openWorkspace();
    if (!info) return;
    tabs.forEach((path) => editor.current?.close(path));
    setTabs([]);
    setActive(null);
    setDirty(new Set());
    setRobot("");
    setScript("");
    applyWorkspace(info);
  };

  const createFile = async () => {
    const path = (newFile ?? "").trim();
    if (!path) return setNewFile(null);
    try {
      await studio().createFile(path, TEMPLATES[extname(path)] ?? "");
      setNewFile(null);
      applyWorkspace(await studio().refreshWorkspace());
      await openFile(path);
    } catch (error) {
      setNotice(`新建失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const startDrag = (event: React.MouseEvent) => {
    event.preventDefault();
    const move = (e: MouseEvent) => setPanelHeight(Math.min(window.innerHeight - 160, Math.max(120, window.innerHeight - e.clientY - 22)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const files = (ext: string) => (ws?.entries ?? []).filter((e) => e.kind === "file" && extname(e.path) === ext).map((e) => e.path);

  return (
    <div className="app">
      <div className="toolbar">
        <button onClick={openWorkspace}>打开工作区</button>
        <span className="workspace-name" title={ws?.root}>{ws ? basename(ws.root) : "未打开"}</span>
        <span className="sep" />
        <label>结构
          <select value={robot} onChange={(e) => setRobot(e.target.value)} disabled={!ws || live} title={live ? "会话进行中，结束会话后才能切换结构" : undefined}>
            <option value="">—</option>
            {files(".sql").map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label>动作
          <select value={script} onChange={(e) => setScript(e.target.value)} disabled={!ws}>
            <option value="">—</option>
            {files(".mt").map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <button onClick={() => void runCheck()} disabled={!robot}>检查</button>
        <button className="primary" onClick={() => void runScript()} disabled={!robot || !script || activating} title="F5">▶ 运行</button>
        <button className="danger" onClick={stopAll} disabled={!activating}>■ 停止</button>
        <button className={live ? "session-on" : ""} onClick={() => void toggleSession()}
          disabled={sessionPending || (!live && (!robot || activating || session.agent))}
          title={live ? "清理驱动并结束会话" : session.agent ? "智能体对话占用机器人，先点「新对话」" : "激活一次，之后运行、采样、热更新 SQL 都复用这个会话"}>
          {live ? "⏏ 结束会话" : "⏻ 激活会话"}
        </button>
        <label>超时 <input type="number" min={1} max={3600} value={timeout} style={{ width: 60 }} onChange={(e) => setTimeoutSec(Number(e.target.value))} />s</label>
        <label className={allowHardware ? "hw-on" : ""} title="打开物理设备；执行前会再次确认">
          <input type="checkbox" checked={allowHardware} disabled={live} onChange={(e) => setAllowHardware(e.target.checked)} />允许硬件
        </label>
        <span className="grow" />
        <button onClick={() => setShowSettings(true)}>设置</button>
      </div>

      <div className="main">
        <div className="sidebar">
          <div className="sidebar-head">
            <span className="grow">资源管理器</span>
            <button disabled={!ws} onClick={() => setNewFile(newFile === null ? "scripts/new.mt" : null)} title="新建文件">＋</button>
            <button disabled={!ws} onClick={async () => applyWorkspace(await studio().refreshWorkspace())} title="刷新">⟳</button>
          </div>
          {newFile !== null && (
            <div className="new-file">
              <input autoFocus value={newFile} onChange={(e) => setNewFile(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void createFile(); if (e.key === "Escape") setNewFile(null); }} />
              <button onClick={() => void createFile()}>建</button>
            </div>
          )}
          {ws && <FileTree key={ws.root} entries={ws.entries} activePath={active} robot={robot} script={script} onOpen={openFile} />}
          {ws?.truncated && <div className="muted" style={{ padding: 8 }}>文件过多，列表已截断</div>}
        </div>

        <div className="center" style={{ ["--panel-h" as string]: `${panelHeight}px` }}>
          <div className="tabs">
            {tabs.map((path) => (
              <div key={path} className={`tab${path === active ? " active" : ""}`} onClick={() => setActive(path)} title={path}>
                <span>{basename(path)}</span>
                {dirty.has(path) && <span className="dirty">●</span>}
                <button className="close" onClick={(e) => { e.stopPropagation(); closeTab(path); }}>×</button>
              </div>
            ))}
          </div>
          <div className="editor-host">
            <Editor
              ref={editor}
              activePath={active}
              onSave={(path) => void saveFile(path)}
              onDirtyChange={(path, isDirty) => setDirty((set) => {
                if (set.has(path) === isDirty) return set;
                const next = new Set(set);
                if (isDirty) next.add(path);
                else next.delete(path);
                return next;
              })}
            />
            {!active && (
              <div className="editor-empty">
                {ws ? <span>从左侧打开 .sql / .mt / .lua 文件。Ctrl+S 保存并检查，F5 运行。</span> : (
                  <>
                    <span>打开一个包含 robots/ scripts/ modules/ 的 pymybot 工作区</span>
                    <button className="primary" onClick={openWorkspace}>打开工作区</button>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="splitter" onMouseDown={startDrag} />
          <div className="panel">
            <div className="panel-tabs">
              {PANELS.map(([id, label]) => (
                <div key={id} className={`panel-tab${panel === id ? " active" : ""}`} onClick={() => setPanel(id)}>
                  {label}
                  {id === "problems" && check.problems.length > 0 && <span className="badge">{check.problems.length}</span>}
                </div>
              ))}
            </div>
            <div className="panel-body" hidden={panel !== "problems"}>
              <ProblemsPanel state={check} onReveal={async (p) => {
                if (!p.path) return;
                await openFile(p.path);
                setTimeout(() => editor.current?.reveal(p.path!, p.line, p.column), 0);
              }} />
            </div>
            <div className="panel-body" hidden={panel !== "output"}><OutputPanel state={runState} /></div>
            <div className="panel-body" hidden={panel !== "hardware"}><HardwarePanel items={hardware} error={hwError} session={live} onRefresh={() => void refreshHardware()} /></div>
            <div className="panel-body" hidden={panel !== "query"}><QueryPanel robot={robot} exec={exec} serveCall={serveCall} session={live} allowHardware={allowHardware}
              onHardware={(items) => setHardware((old) => items.map((item) => ({ ...item, metadata: old.find((h) => h.name === item.name)?.metadata ?? {} })))} /></div>
            <div className="panel-body" hidden={panel !== "sample"}>
              <SamplePanel robot={robot} exec={exec} serveCall={serveCall} session={live} hardware={hardware} allowHardware={allowHardware} visible={panel === "sample"} />
            </div>
            <div className="panel-body" hidden={panel !== "agent"}>
              <AgentPanel robot={robot} serveCall={serveCall} session={session} hardware={hardware} allowHardware={allowHardware} settings={settings} />
            </div>
            <div className="panel-body" hidden={panel !== "log"}><LogPanel entries={log} serveLog={serveLog} onClear={() => { setLog([]); setServeLog(""); }} /></div>
          </div>
        </div>
      </div>

      <div className={`statusbar${activeRuns.length ? " busy" : ""}`}>
        <span>{activeRuns.length ? `运行中：${activeRuns.map((r) => r.command).join(", ")}` : "就绪"}</span>
        {live && <span className="session-badge" title={session.robot}>● 会话 {basename(session.robot ?? "")}{session.allowHardware ? "（硬件）" : ""}</span>}
        {session.agent && <span>● 智能体对话</span>}
        {allowHardware && <span>⚠ 允许硬件</span>}
        {notice && <span>{notice}</span>}
        <span style={{ marginLeft: "auto" }}>{ws?.root ?? ""}</span>
      </div>

      {showSettings && (
        <SettingsDialog onClose={() => setShowSettings(false)} onSaved={setSettings} exec={exec} />
      )}
    </div>
  );
}
