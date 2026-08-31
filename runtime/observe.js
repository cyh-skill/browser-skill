((options = {}) => {
  const maxItems = Math.max(1, Math.min(1000, Number(options.maxItems || 300)));
  const maxText = Math.max(0, Math.min(50000, Number(options.maxText || 12000)));
  const includeOffscreen = Boolean(options.includeOffscreen);
  const STATE_KEY = Symbol.for('cyh-browser-skill.refs.v2');
  let state = window[STATE_KEY];
  if (!state || !(state.refs instanceof Map) || !(state.elements instanceof WeakMap)) {
    state = { refs: new Map(), elements: new WeakMap(), next: 1, generation: 0 };
    Object.defineProperty(window, STATE_KEY, { value: state, configurable: true });
  }
  state.generation += 1;

  const clean = (value, limit = 240) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const documents = [{ document, frame: 'main' }];
  const roots = [];
  const frameWarnings = [];
  for (let i = 0; i < documents.length; i++) {
    const entry = documents[i];
    roots.push({ root: entry.document, document: entry.document, frame: entry.frame });
    for (const frame of entry.document.querySelectorAll('iframe,frame')) {
      try {
        if (frame.contentDocument) documents.push({ document: frame.contentDocument, frame: clean(frame.title || frame.name || frame.src || 'frame') });
        else frameWarnings.push({ frame: clean(frame.title || frame.name || frame.src || 'unavailable frame'), reason: 'unavailable-or-cross-origin' });
      } catch {
        frameWarnings.push({ frame: clean(frame.title || frame.name || frame.src || 'cross-origin frame'), reason: 'cross-origin' });
      }
    }
  }
  for (let i = 0; i < roots.length; i++) {
    const entry = roots[i];
    for (const element of entry.root.querySelectorAll('*')) {
      if (element.shadowRoot) roots.push({ root: element.shadowRoot, document: entry.document, frame: entry.frame });
    }
  }

  const roleFor = (element) => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') || '').toLowerCase();
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'button' || tag === 'summary' || ['button', 'submit', 'reset'].includes(type)) return 'button';
    if (tag === 'textarea' || (tag === 'input' && !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'file', 'hidden'].includes(type))) return 'textbox';
    if (tag === 'select') return 'combobox';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    if (type === 'file') return 'file';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (['main', 'nav', 'aside', 'header', 'footer', 'form'].includes(tag)) return tag;
    return tag;
  };
  const nameFor = (element, doc) => {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const label = labelledBy.split(/\s+/).map((id) => doc.getElementById(id)?.textContent || '').join(' ');
      if (clean(label)) return clean(label);
    }
    if (element.labels?.length) {
      const label = [...element.labels].map((item) => item.textContent || '').join(' ');
      if (clean(label)) return clean(label);
    }
    const type = (element.getAttribute('type') || '').toLowerCase();
    const safeValue = ['button', 'submit', 'reset'].includes(type) ? element.getAttribute('value') : '';
    return clean(element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder') || safeValue || element.innerText || element.textContent);
  };
  const geometry = (element) => {
    const rect = element.getBoundingClientRect();
    const view = element.ownerDocument?.defaultView || window;
    const style = view.getComputedStyle(element);
    const rendered = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    const inViewport = rendered && rect.bottom >= 0 && rect.right >= 0 && rect.top <= view.innerHeight && rect.left <= view.innerWidth;
    return { rendered, inViewport, rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, cursor: style.cursor };
  };
  const selector = [
    'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'summary', 'details',
    '[contenteditable=true]', '[role]', '[tabindex]', '[onclick]', '[aria-label]', '[aria-labelledby]',
    'video[controls]', 'audio[controls]', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'main', 'nav', 'aside', 'header', 'footer', 'form'
  ].join(',');
  const activeRefs = new Set();
  const items = [];
  for (const { root, document: doc, frame } of roots) {
    for (const element of root.querySelectorAll(selector)) {
      if (items.length >= maxItems) break;
      const geo = geometry(element);
      if (!geo.rendered || (!includeOffscreen && !geo.inViewport)) continue;
      let ref = state.elements.get(element);
      if (!ref) {
        ref = '@e' + state.next++;
        state.elements.set(element, ref);
      }
      state.refs.set(ref, element);
      activeRefs.add(ref);
      const role = roleFor(element);
      const item = {
        ref,
        role,
        name: nameFor(element, doc),
        tag: element.tagName.toLowerCase(),
        frame,
        disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
        focused: doc.activeElement === element,
        inViewport: geo.inViewport,
        rect: geo.rect,
      };
      if (element.href) item.href = element.href;
      if (element.type) item.type = element.type;
      if (role === 'checkbox' || role === 'radio') item.checked = Boolean(element.checked || element.getAttribute('aria-checked') === 'true');
      if (element.getAttribute('aria-expanded') != null) item.expanded = element.getAttribute('aria-expanded') === 'true';
      if (element.getAttribute('aria-selected') != null) item.selected = element.getAttribute('aria-selected') === 'true';
      if (element.tagName === 'SELECT') item.selection = [...element.selectedOptions].map((option) => clean(option.textContent || option.value));
      if (element.tagName === 'DETAILS') item.open = element.open;
      if (geo.cursor === 'pointer' && !['link', 'button'].includes(role)) item.pointer = true;
      items.push(item);
    }
  }
  for (const ref of [...state.refs.keys()]) if (!activeRefs.has(ref)) state.refs.delete(ref);

  const headings = items.filter((item) => item.role === 'heading').map(({ ref, name, tag, frame }) => ({ ref, name, level: Number(tag.slice(1)), frame }));
  const landmarks = items.filter((item) => ['main', 'navigation', 'nav', 'aside', 'banner', 'contentinfo', 'form'].includes(item.role)).map(({ ref, role, name, frame }) => ({ ref, role, name, frame }));
  const forms = items.filter((item) => item.tag === 'form').map(({ ref, name, frame }) => ({ ref, name, frame }));
  const textByFrame = documents.map((entry) => ({ frame: entry.frame, text: clean(entry.document.body?.innerText || '', maxText) }));
  const text = clean(textByFrame.map((entry) => entry.text).join('\n'), maxText);
  return {
    schemaVersion: 2,
    generation: state.generation,
    title: document.title,
    url: location.href,
    language: document.documentElement.lang || navigator.language,
    readyState: document.readyState,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    scroll: { x: Math.round(scrollX), y: Math.round(scrollY), height: document.documentElement.scrollHeight },
    count: items.length,
    headings,
    landmarks,
    forms,
    items,
    text,
    textByFrame,
    frames: documents.map((entry) => entry.frame),
    warnings: frameWarnings,
  };
})
