import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { LANGUAGE_BY_EXT, monaco } from "../monaco";
import { extname } from "../util";

export interface Marker {
  line: number;
  column: number;
  message: string;
}

export interface EditorHandle {
  open(path: string, text: string): void;
  close(path: string): void;
  has(path: string): boolean;
  text(path: string): string | null;
  markSaved(path: string): void;
  setMarkers(path: string, markers: Marker[]): void;
  reveal(path: string, line: number, column: number): void;
}

interface Props {
  activePath: string | null;
  onDirtyChange(path: string, dirty: boolean): void;
  onSave(path: string): void;
}

interface Entry {
  model: monaco.editor.ITextModel;
  savedVersion: number;
  view: monaco.editor.ICodeEditorViewState | null;
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor({ activePath, onDirtyChange, onSave }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const entries = useRef(new Map<string, Entry>());
  const current = useRef<string | null>(null);
  const callbacks = useRef({ onDirtyChange, onSave });
  callbacks.current = { onDirtyChange, onSave };

  useEffect(() => {
    const instance = monaco.editor.create(host.current!, {
      theme: "vs-dark",
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      renderWhitespace: "boundary",
      tabSize: 4,
      model: null,
    });
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (current.current) callbacks.current.onSave(current.current);
    });
    editor.current = instance;
    return () => {
      instance.dispose();
      entries.current.forEach((entry) => entry.model.dispose());
      entries.current.clear();
    };
  }, []);

  useEffect(() => {
    const instance = editor.current!;
    if (current.current) {
      const previous = entries.current.get(current.current);
      if (previous) previous.view = instance.saveViewState();
    }
    current.current = activePath;
    const entry = activePath ? entries.current.get(activePath) : undefined;
    instance.setModel(entry?.model ?? null);
    if (entry?.view) instance.restoreViewState(entry.view);
    if (entry) instance.focus();
  }, [activePath]);

  useImperativeHandle(ref, () => ({
    open(path, text) {
      if (entries.current.has(path)) return;
      const model = monaco.editor.createModel(text, LANGUAGE_BY_EXT[extname(path)] ?? "plaintext", monaco.Uri.from({ scheme: "studio", path: `/${path}` }));
      const entry: Entry = { model, savedVersion: model.getAlternativeVersionId(), view: null };
      model.onDidChangeContent(() => callbacks.current.onDirtyChange(path, model.getAlternativeVersionId() !== entry.savedVersion));
      entries.current.set(path, entry);
    },
    close(path) {
      const entry = entries.current.get(path);
      if (!entry) return;
      if (current.current === path) editor.current?.setModel(null);
      entry.model.dispose();
      entries.current.delete(path);
    },
    has: (path) => entries.current.has(path),
    text: (path) => entries.current.get(path)?.model.getValue() ?? null,
    markSaved(path) {
      const entry = entries.current.get(path);
      if (!entry) return;
      entry.savedVersion = entry.model.getAlternativeVersionId();
      callbacks.current.onDirtyChange(path, false);
    },
    setMarkers(path, markers) {
      const entry = entries.current.get(path);
      if (!entry) return;
      monaco.editor.setModelMarkers(entry.model, "pymybot", markers.map((m) => ({
        severity: monaco.MarkerSeverity.Error,
        message: m.message,
        startLineNumber: m.line,
        startColumn: m.column,
        endLineNumber: m.line,
        endColumn: entry.model.getLineMaxColumn(Math.min(m.line, entry.model.getLineCount())),
      })));
    },
    reveal(path, line, column) {
      if (current.current !== path) return;
      editor.current?.revealLineInCenter(line);
      editor.current?.setPosition({ lineNumber: line, column });
      editor.current?.focus();
    },
  }), []);

  return <div ref={host} className="monaco" />;
});
