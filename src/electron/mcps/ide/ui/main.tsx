import React from "react";
import ReactDOM from "react-dom/client";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker&inline";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker&inline";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker&inline";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker&inline";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker&inline";
import App from "./App";
import "./fonts.css";
import "./App.css";

/**
 * MCP IDE Entry Point
 *
 * Renders the IDE application into the DOM.
 */
type MonacoWorkerLabel =
  | "typescript"
  | "javascript"
  | "json"
  | "css"
  | "scss"
  | "less"
  | "html"
  | "handlebars"
  | "razor";

/**
 * Select the appropriate Monaco worker for the given language label.
 * Uses inline worker bundles to avoid network fetches in srcdoc iframes.
 */
const getMonacoWorker = ({ label }: { label: MonacoWorkerLabel }): Worker => {
  switch (label) {
    case "json":
      return new JsonWorker();
    case "css":
    case "scss":
    case "less":
      return new CssWorker();
    case "html":
    case "handlebars":
    case "razor":
      return new HtmlWorker();
    case "typescript":
    case "javascript":
      return new TsWorker();
    default:
      return new EditorWorker();
  }
};

/**
 * Configure Monaco to use inline web workers.
 * Prevents MIME errors when the UI is loaded via srcdoc without a file server.
 */
const initializeMonacoWorkers = (): void => {
  const globalScope = globalThis as typeof globalThis & {
    MonacoEnvironment?: {
      getWorker: (moduleId: string, label: MonacoWorkerLabel) => Worker;
    };
  };

  globalScope.MonacoEnvironment = {
    getWorker: (_moduleId: string, label: MonacoWorkerLabel) => getMonacoWorker({ label }),
  };
};

initializeMonacoWorkers();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

