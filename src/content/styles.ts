/** Styles inside the overlay's shadow root. Uses only local system fonts. */
export const OVERLAY_CSS = `
* { box-sizing: border-box; }

.root {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: #16181d;
  color: #a7adb8;
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  text-align: center;
}

.frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
  background: transparent;
  color-scheme: dark;
}

.panel {
  max-width: 520px;
  max-height: 100%;
  overflow: auto;
}

.title {
  margin: 0 0 8px;
  color: #e6e3da;
  font-size: 22px;
  font-weight: 600;
}

.body { margin: 0 0 20px; }

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: center;
}

button {
  min-width: 140px;
  padding: 10px 18px;
  border: 1px solid #343944;
  border-radius: 8px;
  background: #20242c;
  color: #e6e3da;
  font: inherit;
  cursor: pointer;
}
button:hover { background: #272c36; }
button:focus-visible { outline: 2px solid #74c7b8; outline-offset: 2px; }
button.primary { border-color: transparent; background: #74c7b8; color: #0f1a18; font-weight: 600; }
button.primary:hover { background: #86d3c5; }

.checking {
  opacity: 0;
  animation: fade-in 0.2s ease 0.6s forwards;
}
.checking .body { color: #6f7480; font-size: 13px; }

@keyframes fade-in { to { opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  .checking { animation: none; opacity: 1; }
}
`;
