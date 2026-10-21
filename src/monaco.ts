import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

monaco.languages.register({ id: "mt", extensions: [".mt"], aliases: ["pymybot action"] });
monaco.languages.setLanguageConfiguration("mt", {
  comments: { lineComment: "#" },
  brackets: [["(", ")"]],
  autoClosingPairs: [{ open: "(", close: ")" }, { open: '"', close: '"' }],
});
monaco.languages.setMonarchTokensProvider("mt", {
  tokenizer: {
    root: [
      [/#.*$/, "comment"],
      [/@(?:if|while)(?=\()/, "keyword", "@cond"],
      [/@[A-Za-z_][\w.-]*/, "keyword"],
      [/@/, "keyword"],
      [/\$\(/, "delimiter.bracket", "@expr"],
      [/\$[A-Za-z_][\w-]*=[\w.]+/, "variable"],
      [/[A-Za-z_][\w-]*\.[A-Za-z_][\w.]*/, "type"],
      [/0[xX][0-9a-fA-F]+/, "number.hex"],
      [/[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/, "number"],
      [/;/, "delimiter"],
      [/-(?=[\s;])/, "operator"],
      [/[A-Za-z_][\w-]*/, "identifier"],
    ],
    cond: [
      [/\(/, "delimiter.parenthesis", "@expr"],
      [/./, "", "@pop"],
      [/$/, "", "@pop"],
    ],
    expr: [
      [/\(/, "delimiter.parenthesis", "@push"],
      [/\)/, "delimiter.parenthesis", "@pop"],
      [/"(?:[^"\\]|\\.)*"/, "string"],
      [/0[xX][0-9a-fA-F.]+(?:p[-+]?\d+)?/, "number.hex"],
      [/\d+(?:\.\d+)?/, "number"],
      [/[A-Za-z_][\w-]*/, "variable"],
      [/[-+*/%<>=!&|]+/, "operator"],
    ],
  },
});

export const LANGUAGE_BY_EXT: Record<string, string> = { ".mt": "mt", ".sql": "sql", ".lua": "lua", ".md": "markdown" };

export { monaco };
