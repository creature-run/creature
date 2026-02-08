/**
 * UI Entry Point
 *
 * Renders the React app into the DOM root element.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
