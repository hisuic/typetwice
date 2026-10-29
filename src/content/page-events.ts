export interface PageEventHandlers {
  /** The URL changed without loading a new document (SPA navigation, history, hash). */
  onUrlChange(): void;
  /** The user came back to this page from another tab, window or app. */
  onReturn(): void;
  /** The page was shown again; `persisted` is true when it came from the back/forward cache. */
  onPageShow(persisted: boolean): void;
}

interface NavigationLike extends EventTarget {
  addEventListener(type: 'currententrychange', listener: () => void): void;
  removeEventListener(type: 'currententrychange', listener: () => void): void;
}

/** Watches the events that should re-check an expired unlock. Returns a function that stops watching. */
export function watchPage(handlers: PageEventHandlers): () => void {
  let lastHref = location.href;
  const checkUrl = () => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    handlers.onUrlChange();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') handlers.onReturn();
  };
  const onFocus = () => handlers.onReturn();
  const onPageShow = (event: PageTransitionEvent) => {
    lastHref = location.href;
    handlers.onPageShow(event.persisted);
  };

  // The Navigation API sees pushState/replaceState made by the page itself,
  // without patching history methods in the page's own JavaScript world.
  const navigation = (window as Window & { navigation?: NavigationLike }).navigation;
  navigation?.addEventListener('currententrychange', checkUrl);
  window.addEventListener('popstate', checkUrl);
  window.addEventListener('hashchange', checkUrl);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);
  window.addEventListener('pageshow', onPageShow);

  return () => {
    navigation?.removeEventListener('currententrychange', checkUrl);
    window.removeEventListener('popstate', checkUrl);
    window.removeEventListener('hashchange', checkUrl);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('pageshow', onPageShow);
  };
}
