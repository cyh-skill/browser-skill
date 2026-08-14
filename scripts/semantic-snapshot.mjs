const DEFAULT_MAX_ITEMS = 220;
const DEFAULT_MAX_NAME_LENGTH = 160;

export function semanticSnapshotExpression(options = {}) {
  const maxItems = clampInteger(options.maxItems, 1, 1000, DEFAULT_MAX_ITEMS);
  const maxNameLength = clampInteger(options.maxNameLength, 20, 500, DEFAULT_MAX_NAME_LENGTH);

  return `(() => {
    const STATE_KEY = Symbol.for('cyh-browser-skill.refs.v1');
    let state = window[STATE_KEY];
    if (!state || !(state.refs instanceof Map) || !(state.elements instanceof WeakMap)) {
      state = { refs: new Map(), elements: new WeakMap(), next: 1 };
      Object.defineProperty(window, STATE_KEY, { value: state, configurable: true });
    }
    const selector = [
      'a[href]', 'button', 'input', 'textarea', 'select', 'summary',
      '[contenteditable="true"]', '[role]', '[tabindex]', '[aria-label]',
      'video[controls]', 'audio[controls]'
    ].join(',');
    const roleFor = (el) => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
        return 'textbox';
      }
      return tag;
    };
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, ${maxNameLength});
    const nameFor = (el) => {
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const value = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
        if (clean(value)) return clean(value);
      }
      if (el.labels?.length) {
        const value = [...el.labels].map((label) => label.textContent || '').join(' ');
        if (clean(value)) return clean(value);
      }
      const inputType = (el.getAttribute('type') || '').toLowerCase();
      const safeValue = ['button', 'submit', 'reset'].includes(inputType) ? el.getAttribute('value') : '';
      return clean(el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title')
        || el.getAttribute('placeholder') || safeValue || el.textContent);
    };
    const visible = (el) => {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0
        && rect.top <= innerHeight && rect.left <= innerWidth;
    };
    const roots = [document];
    const candidates = [];
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (el.matches?.(selector)) candidates.push(el);
      }
    }
    const items = [];
    const activeRefs = new Set();
    for (const el of candidates) {
      if (items.length >= ${maxItems} || !visible(el)) continue;
      let ref = state.elements.get(el);
      if (!ref) {
        ref = '@e' + state.next++;
        state.elements.set(el, ref);
      }
      state.refs.set(ref, el);
      activeRefs.add(ref);
      const rect = el.getBoundingClientRect();
      const item = {
        ref,
        role: roleFor(el),
        name: nameFor(el),
        tag: el.tagName.toLowerCase(),
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      };
      if (el.href) item.href = el.href;
      if (el.type) item.type = el.type;
      items.push(item);
    }
    for (const ref of [...state.refs.keys()]) if (!activeRefs.has(ref)) state.refs.delete(ref);
    return { title: document.title, url: location.href, count: items.length, items };
  })()`;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
