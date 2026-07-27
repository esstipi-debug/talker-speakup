import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { releaseMicStream } from "./lib/micStream.js";
import "./index.css";

// The single release path. Capture is only ever acquired from an event
// handler (never an effect), so StrictMode's double-invoke can't open it twice.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") releaseMicStream();
});

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
