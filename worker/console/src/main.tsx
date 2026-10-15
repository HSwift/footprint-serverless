import { createRoot } from "react-dom/client";
import "@fontsource-variable/noto-sans";
import "@fontsource-variable/noto-sans-arabic";
import "@fontsource-variable/noto-sans-hebrew";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/geist-mono";
import "mapbox-gl/dist/mapbox-gl.css";
import { App } from "./App";
import "./style.css";

// Keep one map instance in development too; StrictMode's remount would create
// an additional billable map load on every initial development render.
createRoot(document.getElementById("root")!).render(<App />);
