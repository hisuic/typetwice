import { OVERLAY_CSS } from './styles';

export const HOST_TAG = 'typetwice-gate';

/** Inline !important styles win over anything the page's stylesheets say about the host. */
const HOST_STYLES: ReadonlyArray<[string, string]> = [
  ['all', 'initial'],
  ['position', 'fixed'],
  ['inset', '0'],
  ['width', '100%'],
  ['height', '100%'],
  ['max-width', 'none'],
  ['max-height', 'none'],
  ['margin', '0'],
  ['padding', '0'],
  ['border', '0'],
  ['display', 'block'],
  ['z-index', '2147483647'],
  ['background-color', '#16181d'],
  ['color-scheme', 'dark'],
  ['opacity', '1'],
  ['visibility', 'visible'],
  ['transform', 'none'],
  ['filter', 'none'],
  ['pointer-events', 'auto'],
  ['direction', 'ltr'],
];

interface SavedPageState {
  focus: HTMLElement | null;
  ranges: Range[];
  scrollX: number;
  scrollY: number;
  href: string;
}

/**
 * The opaque full-screen cover and everything it changes on the page.
 * While mounted it keeps the page from scrolling or taking focus; when
 * removed it puts back only the values it changed itself.
 */
export class PageGuard {
  readonly host: HTMLElement;
  private readonly root: HTMLElement;
  private mounted = false;
  private observer: MutationObserver | null = null;
  private overflow: { value: string; priority: string; hadStyleAttribute: boolean } | null = null;
  private inertBody: HTMLElement | null = null;
  private saved: SavedPageState | null = null;

  /** `onRepair` returns false when this instance should give up instead of re-adding itself. */
  constructor(private readonly onRepair: () => boolean) {
    this.host = document.createElement(HOST_TAG);
    for (const [property, value] of HOST_STYLES) this.host.style.setProperty(property, value, 'important');
    const shadow = this.host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(OVERLAY_CSS);
    shadow.adoptedStyleSheets = [sheet];

    this.root = document.createElement('div');
    this.root.className = 'root';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'TypeTwice');
    shadow.append(this.root);

    // Keystrokes on the overlay's own buttons must not reach the page's shortcut handlers.
    for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input']) {
      shadow.addEventListener(type, (event) => event.stopPropagation());
    }
  }

  get isMounted(): boolean {
    return this.mounted;
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.saveState();
    this.attach();
    this.suppressPage();
    this.observer = new MutationObserver(() => this.repair());
    this.observe();
  }

  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.observer?.disconnect();
    this.observer = null;
    try {
      if (this.host.matches(':popover-open')) this.host.hidePopover();
    } catch {
      // Popover support is optional; removal below is what matters.
    }
    this.host.remove();
    this.root.replaceChildren();
    this.releasePage();
    this.restoreState();
  }

  /** Replaces what the overlay shows. */
  setContent(...nodes: Node[]): void {
    this.root.replaceChildren(...nodes);
  }

  /** Adds a layer above the current content (used for the gate iframe). */
  addLayer(node: Node): void {
    this.root.append(node);
  }

  private attach(): void {
    const parent = document.documentElement;
    if (!parent) return;
    if (this.host.parentNode !== parent) parent.append(this.host);
    // The top layer keeps the cover above page content regardless of z-index or transforms.
    try {
      if (!this.host.hasAttribute('popover')) this.host.setAttribute('popover', 'manual');
      if (!this.host.matches(':popover-open')) this.host.showPopover();
    } catch {
      // Fall back to fixed positioning with the maximum z-index.
    }
  }

  private observe(): void {
    if (!this.observer) return;
    this.observer.observe(document, { childList: true });
    if (document.documentElement) this.observer.observe(document.documentElement, { childList: true });
  }

  /** Puts the cover back if the page removed it and covers a replaced <body>. */
  private repair(): void {
    if (!this.mounted) return;
    if (this.host.parentNode !== document.documentElement) {
      if (!this.onRepair()) return;
      this.observer?.disconnect();
      this.attach();
      this.observe();
    }
    this.applyInert();
  }

  private suppressPage(): void {
    const html = document.documentElement;
    if (html && !this.overflow) {
      this.overflow = {
        value: html.style.getPropertyValue('overflow'),
        priority: html.style.getPropertyPriority('overflow'),
        hadStyleAttribute: html.hasAttribute('style'),
      };
      html.style.setProperty('overflow', 'hidden', 'important');
    }
    this.applyInert();
  }

  /** inert keeps clicks, focus, Tab and find-in-page out of the page behind the cover. */
  private applyInert(): void {
    const body = document.body;
    if (!body || body === this.inertBody || body.inert) return;
    if (this.inertBody && !this.inertBody.isConnected) this.inertBody.inert = false;
    body.inert = true;
    this.inertBody = body;
  }

  private releasePage(): void {
    const html = document.documentElement;
    if (html && this.overflow) {
      const stillOurs =
        html.style.getPropertyValue('overflow') === 'hidden' && html.style.getPropertyPriority('overflow') === 'important';
      if (stillOurs) {
        if (this.overflow.value) {
          html.style.setProperty('overflow', this.overflow.value, this.overflow.priority);
        } else {
          html.style.removeProperty('overflow');
          if (!this.overflow.hadStyleAttribute && html.getAttribute('style') === '') html.removeAttribute('style');
        }
      }
    }
    this.overflow = null;
    if (this.inertBody) {
      this.inertBody.inert = false;
      this.inertBody = null;
    }
  }

  private saveState(): void {
    let active: Element | null = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    const focus =
      active instanceof HTMLElement && active !== document.body && active !== document.documentElement ? active : null;
    const selection = document.getSelection();
    const ranges: Range[] = [];
    if (selection) {
      for (let i = 0; i < selection.rangeCount; i += 1) ranges.push(selection.getRangeAt(i).cloneRange());
    }
    this.saved = { focus, ranges, scrollX: window.scrollX, scrollY: window.scrollY, href: location.href };
  }

  /** Restores focus, caret and scroll position as far as the page still allows it. */
  private restoreState(): void {
    const saved = this.saved;
    this.saved = null;
    if (!saved || saved.href !== location.href) return;
    if (window.scrollX !== saved.scrollX || window.scrollY !== saved.scrollY) {
      window.scrollTo({ left: saved.scrollX, top: saved.scrollY, behavior: 'instant' });
    }
    const focus = saved.focus;
    if (!focus?.isConnected) return;
    focus.focus({ preventScroll: true });
    if (focus.isContentEditable && saved.ranges.length > 0) {
      const selection = document.getSelection();
      const inside = saved.ranges.every((r) => focus.contains(r.startContainer) && focus.contains(r.endContainer));
      if (selection && inside) {
        selection.removeAllRanges();
        for (const range of saved.ranges) selection.addRange(range);
      }
    }
  }
}
