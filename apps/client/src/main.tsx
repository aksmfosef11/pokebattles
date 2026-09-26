import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import galmuri11 from "galmuri/dist/Galmuri11.woff2?url";
import galmuri14 from "galmuri/dist/Galmuri14.woff2?url";
import "./styles.css";
import { App } from "./App.tsx";
import { installSound } from "./audio.ts";
import { I18nProvider } from "./i18n.tsx";

// Galmuri (SIL OFL 1.1) pixel fonts; only the two weights the UI uses.
for (const [family, url] of [
  ["Galmuri11", galmuri11],
  ["Galmuri14", galmuri14],
] as const) {
  const face = new FontFace(family, `url(${url}) format("woff2")`, { display: "swap" });
  document.fonts.add(face);
  face.load().catch(() => undefined);
}

installSound();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
