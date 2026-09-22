import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);

const PRELOADER_MIN_MS = 2200;
const PRELOADER_FADE_MS = 400;

const preloader = document.getElementById("preloader");
if (preloader) {
  setTimeout(() => {
    preloader.classList.add("hide");
    setTimeout(() => preloader.remove(), PRELOADER_FADE_MS);
  }, PRELOADER_MIN_MS);
}
