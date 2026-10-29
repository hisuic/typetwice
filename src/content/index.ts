import { parseHttpUrl } from '../core/sites';
import { GateController } from './controller';
import { HOST_TAG } from './page-guard';

interface GateInstance {
  isAlive(): boolean;
  dispose(): void;
}

// Lives in the extension's isolated world; the page cannot see or call it.
const scope = globalThis as typeof globalThis & { __typetwiceGate?: GateInstance };

function run(): void {
  if (window.top !== window || !parseHttpUrl(location.href)) return;

  const previous = scope.__typetwiceGate;
  // Injected twice into the same page (registration and an explicit injection): keep the live one.
  if (previous?.isAlive()) return;
  // An instance from before an extension reload can no longer talk to the worker; replace it.
  previous?.dispose();
  for (const stray of document.querySelectorAll(HOST_TAG)) stray.remove();

  const controller = new GateController();
  scope.__typetwiceGate = controller;
  controller.start();
}

run();
