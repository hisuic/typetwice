type Child = Node | string | null | undefined | false;

/** Creates an element with attributes and children; text is always set as text, never parsed as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (name === 'class') element.className = String(value);
    else element.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) element.append(child);
  }
  return element;
}

export function button(label: string, onClick: () => void, className?: string): HTMLButtonElement {
  const element = h('button', { type: 'button', class: className });
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}
