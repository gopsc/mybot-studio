import { useEffect, useState } from "react";
import type { RunResult, Settings } from "../../shared/types";
import { failureText, studio } from "../util";

interface Props {
  onClose(): void;
  onSaved(settings: Settings): void;
  exec(request: { command: "scripts" }): Promise<RunResult>;
}

export function SettingsDialog({ onClose, onSaved, exec }: Props) {
  const [form, setForm] = useState<Settings | null>(null);
  const [resolved, setResolved] = useState("");
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void studio().getSettings().then(setForm);
    void studio().resolvePython().then(setResolved);
  }, []);
  if (!form) return null;

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setForm({ ...form, [key]: value });
  const save = async () => {
    const saved = await studio().setSettings(form);
    setForm(saved);
    setResolved(await studio().resolvePython());
    onSaved(saved);
    return saved;
  };
  const test = async () => {
    await save();
    setProbe({ ok: true, text: "检测中…" });
    const result = await exec({ command: "scripts" });
    const error = failureText(result);
    setProbe(error ? { ok: false, text: error } : { ok: true, text: `可用：${result.argv[0]}（${result.durationMs} ms）` });
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>设置</h2>
        <div className="field">
          <span>Python 解释器（需已安装 pymybot）</span>
          <input value={form.python} placeholder={`留空自动：${resolved}`} onChange={(e) => set("python", e.target.value)} />
          <small>留空时依次尝试工作区 .venv / venv，再回退到 PATH 中的 python3（Windows 为 python）。</small>
        </div>
        <div className="row">
          <button onClick={test}>检测 pymybot</button>
          {probe && <span className={probe.ok ? "ok" : "err"}>{probe.text}</span>}
        </div>
        <div className="field">
          <span>模块路径 --module-path（每行一个，可相对工作区）</span>
          <textarea rows={3} value={form.modulePaths.join("\n")} onChange={(e) => set("modulePaths", e.target.value.split("\n"))} />
          <small>留空使用 pymybot 默认搜索路径。显式指定会替换默认路径，须同时包含 pymybot 自带的 modules 目录。</small>
        </div>
        <div className="field">
          <span>图片源目录 --camera-src-dir（可选）</span>
          <input value={form.cameraSrcDir} onChange={(e) => set("cameraSrcDir", e.target.value)} />
        </div>
        <h2>智能体</h2>
        <div className="field">
          <span>模型 --model（留空用 MYBOT_MODEL 环境变量）</span>
          <input value={form.model} placeholder="openai-chat:qwen2.5:14b" onChange={(e) => set("model", e.target.value)} />
        </div>
        <div className="field">
          <span>端点 --base-url（留空用 MYBOT_BASE_URL 或厂商默认）</span>
          <input value={form.baseUrl} placeholder="http://127.0.0.1:8000/v1" onChange={(e) => set("baseUrl", e.target.value)} />
          <small>要求 HTTPS；只有 localhost / 127.0.0.1 / ::1 允许 HTTP。</small>
        </div>
        <div className="field">
          <span>API Key 环境变量名 --api-key-env</span>
          <input value={form.apiKeyEnv} placeholder="OPENAI_API_KEY" onChange={(e) => set("apiKeyEnv", e.target.value)} />
          <small>只保存变量名。密钥需在启动 Studio 前设置到环境变量里，Studio 不读取也不存储密钥本身。</small>
        </div>
        <div className="actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={async () => { await save(); onClose(); }}>保存</button>
        </div>
      </div>
    </div>
  );
}
