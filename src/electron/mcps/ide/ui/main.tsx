import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./fonts.css";
import "./App.css";

/**
 * MCP IDE Entry Point
 *
 * Renders the IDE application into the DOM.
 */
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

