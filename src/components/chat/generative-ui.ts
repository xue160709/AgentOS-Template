/**
 * Generative UI parsing and iframe safety helpers.
 * The renderer accepts `show-widget` code fences and turns them into sandboxed widgets.
 */

export type GenerativeWidgetData = {
  title?: string
  widgetCode: string
  streaming: boolean
  scriptTruncated?: boolean
}

export type GenerativeUiSegment =
  | {
      type: 'text'
      content: string
    }
  | {
      type: 'widget'
      data: GenerativeWidgetData
    }
  | {
      type: 'pending'
    }

const WIDGET_MARKER_RE = /`{1,3}show-widget`{0,3}\s*(?:\n\s*`{3}(?:json)?\s*)?\n?/g
const DANGEROUS_CONTAINER_TAGS = /<(iframe|object|embed|form)[\s>][\s\S]*?<\/\1>/gi
const DANGEROUS_VOID_TAGS = /<(iframe|object|embed|meta|link|base)\b[^>]*\/?>/gi
const SCRIPT_TAG_RE = /<script[\s\S]*?<\/script>/gi
const SCRIPT_OPEN_RE = /<script\b[^>]*\/?>/gi
const EVENT_HANDLER_ATTR_RE = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']*)/gi
const URL_ATTR_RE = /\s+(href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']*))/gi
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com', 'esm.sh']

/** True when a response contains a Generative UI marker. */
export function containsGenerativeWidget(text: string): boolean {
  return /`{1,3}show-widget/.test(text)
}

/** Parse completed widgets and, while streaming, the currently open widget. */
export function parseGenerativeUiSegments(text: string, allowPartial: boolean): GenerativeUiSegment[] {
  const segments: GenerativeUiSegment[] = []
  const markerRe = new RegExp(WIDGET_MARKER_RE)
  let lastIndex = 0
  let foundWidgetSyntax = false
  let match: RegExpExecArray | null

  while ((match = markerRe.exec(text)) !== null) {
    const markerStart = match.index
    const afterMarker = markerStart + match[0].length
    const jsonStart = findNearbyJsonStart(text, afterMarker)
    foundWidgetSyntax = true

    if (jsonStart === -1) {
      appendTextSegment(segments, text.slice(lastIndex, markerStart))
      if (allowPartial) segments.push({ type: 'pending' })
      lastIndex = text.length
      break
    }

    const jsonEnd = findJsonObjectEnd(text, jsonStart)
    appendTextSegment(segments, text.slice(lastIndex, markerStart))

    if (jsonEnd === -1) {
      if (allowPartial) {
        const partial = parsePartialWidget(text.slice(jsonStart))
        segments.push(partial ? { type: 'widget', data: partial } : { type: 'pending' })
      }
      lastIndex = text.length
      break
    }

    const parsed = parseWidgetJson(text.slice(jsonStart, jsonEnd + 1))
    if (parsed) {
      segments.push({
        type: 'widget',
        data: {
          ...parsed,
          streaming: false,
        },
      })
    }

    const end = consumeTrailingFence(text, jsonEnd + 1)
    lastIndex = end
    markerRe.lastIndex = end
  }

  if (!foundWidgetSyntax) return []
  appendTextSegment(segments, text.slice(lastIndex))
  return segments
}

/** Sanitized preview: static HTML only while the model is still streaming. */
export function sanitizeWidgetPreview(html: string): string {
  return stripUnsafeUrls(
    html
      .replace(DANGEROUS_CONTAINER_TAGS, '')
      .replace(DANGEROUS_VOID_TAGS, '')
      .replace(EVENT_HANDLER_ATTR_RE, '')
      .replace(SCRIPT_TAG_RE, '')
      .replace(SCRIPT_OPEN_RE, ''),
  )
}

/** Final sandbox HTML: keep scripts/handlers, strip tags that can nest or escape embeds. */
export function sanitizeWidgetFinal(html: string): string {
  return stripUnsafeUrls(
    html
      .replace(DANGEROUS_CONTAINER_TAGS, '')
      .replace(DANGEROUS_VOID_TAGS, ''),
  )
}

/** Build the long-lived receiver iframe document. */
export function buildWidgetSrcdoc(styleBlock: string, prefersDark: boolean): string {
  const scriptSources = CDN_HOSTS.map((host) => `https://${host}`).join(' ')
  const csp = [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${scriptSources}`,
    "style-src 'unsafe-inline'",
    "img-src https: data: blob:",
    "font-src https: data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')

  const receiverScript = `(() => {
const root = document.getElementById('widget-root');
let resizeTimer = 0;
let lastHeight = 0;

function reportHeight() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const height = Math.ceil(root.getBoundingClientRect().height);
    if (height > 0 && height !== lastHeight) {
      lastHeight = height;
      parent.postMessage({ type: 'generative-ui:resize', height }, '*');
    }
  }, 50);
}

new ResizeObserver(reportHeight).observe(root);

function applyHtml(html) {
  root.innerHTML = html;
  reportHeight();
}

function runScripts(scripts) {
  const external = scripts.filter((script) => script.src);
  const inline = scripts.filter((script) => !script.src && script.text);
  let remaining = external.length;

  function runInline() {
    inline.forEach((scriptData) => {
      const node = document.createElement('script');
      scriptData.attrs.forEach((attr) => node.setAttribute(attr.name, attr.value));
      node.textContent = scriptData.text;
      root.appendChild(node);
    });
    reportHeight();
    setTimeout(() => parent.postMessage({ type: 'generative-ui:scripts-ready' }, '*'), 40);
  }

  if (remaining === 0) {
    runInline();
    return;
  }

  external.forEach((scriptData) => {
    const node = document.createElement('script');
    node.src = scriptData.src;
    scriptData.attrs.forEach((attr) => {
      if (attr.name !== 'src' && attr.name !== 'onload') node.setAttribute(attr.name, attr.value);
    });
    const done = () => {
      remaining -= 1;
      if (remaining <= 0) runInline();
    };
    node.onload = done;
    node.onerror = done;
    root.appendChild(node);
  });
}

function finalizeHtml(html) {
  const next = document.createElement('div');
  next.innerHTML = html;
  const scripts = Array.from(next.querySelectorAll('script')).map((node) => {
    const attrs = Array.from(node.attributes).map((attr) => ({ name: attr.name, value: attr.value }));
    const src = node.getAttribute('src') || '';
    const text = node.textContent || '';
    node.remove();
    return { src, text, attrs };
  });

  if (root.innerHTML !== next.innerHTML) root.innerHTML = next.innerHTML;
  runScripts(scripts);
  reportHeight();
}

function captureSvg() {
  const rect = root.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(rect.width || root.scrollWidth || 920));
  const height = Math.max(1, Math.ceil(rect.height || root.scrollHeight || 320));
  const serializer = new XMLSerializer();
  const svgNs = 'http://www.w3.org/2000/svg';
  const styleText = Array.from(document.querySelectorAll('style')).map((style) => style.textContent || '').join('\\n');
  const varText = collectCssVars(styleText);
  const visualChildren = Array.from(root.children).filter((node) => {
    const tag = node.tagName.toLowerCase();
    return tag !== 'style' && tag !== 'script';
  });

  if (visualChildren.length === 1 && visualChildren[0].tagName.toLowerCase() === 'svg') {
    const svg = visualChildren[0].cloneNode(true);
    svg.setAttribute('xmlns', svgNs);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('style', varText + 'background:#fff;' + (svg.getAttribute('style') || ''));
    if (styleText.trim()) {
      const styleNode = document.createElementNS(svgNs, 'style');
      styleNode.textContent = styleText;
      svg.insertBefore(styleNode, svg.firstChild);
    }
    const backgroundNode = document.createElementNS(svgNs, 'rect');
    backgroundNode.setAttribute('x', '0');
    backgroundNode.setAttribute('y', '0');
    backgroundNode.setAttribute('width', '100%');
    backgroundNode.setAttribute('height', '100%');
    backgroundNode.setAttribute('fill', '#fff');
    const insertBefore = styleText.trim() ? styleNodeNextSibling(svg) : svg.firstChild;
    svg.insertBefore(backgroundNode, insertBefore);
    return serializer.serializeToString(svg);
  }

  const wrapper = document.createElement('div');
  wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  wrapper.setAttribute('style', varText + 'width:' + width + 'px;min-height:' + height + 'px;margin:0;background:#fff;color:var(--color-text-primary);font-family:var(--font-sans);');
  if (styleText.trim()) {
    const styleNode = document.createElement('style');
    styleNode.textContent = styleText;
    wrapper.appendChild(styleNode);
  }
  const rootClone = root.cloneNode(true);
  rootClone.querySelectorAll('script').forEach((node) => node.remove());
  wrapper.appendChild(rootClone);
  return '<svg xmlns="' + svgNs + '" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" style="background:#fff"><rect width="100%" height="100%" fill="#fff"/><foreignObject width="100%" height="100%">' + serializer.serializeToString(wrapper) + '</foreignObject></svg>';
}

function styleNodeNextSibling(svg) {
  const first = svg.firstChild;
  return first && first.nodeName.toLowerCase() === 'style' ? first.nextSibling : first;
}

function collectCssVars(styleText) {
  const computed = getComputedStyle(document.documentElement);
  const names = {};
  styleText.replace(/--[A-Za-z0-9_-]+/g, (name) => {
    names[name] = true;
    return name;
  });
  [
    '--font-sans',
    '--font-mono',
    '--color-background-primary',
    '--color-background-secondary',
    '--color-background-tertiary',
    '--color-text-primary',
    '--color-text-secondary',
    '--color-text-tertiary',
    '--color-border-primary',
    '--color-border-secondary',
    '--color-border-tertiary',
    '--color-accent-primary',
    '--border-radius-md',
    '--border-radius-lg',
  ].forEach((name) => {
    names[name] = true;
  });
  return Object.keys(names).map((name) => {
    const value = computed.getPropertyValue(name).trim();
    return value ? name + ':' + value + ';' : '';
  }).join('');
}

window.addEventListener('message', (event) => {
  if (!event.data || typeof event.data.type !== 'string') return;
  if (event.data.type === 'generative-ui:update') applyHtml(String(event.data.html || ''));
  if (event.data.type === 'generative-ui:finalize') finalizeHtml(String(event.data.html || ''));
  if (event.data.type === 'generative-ui:capture-svg') {
    parent.postMessage({ type: 'generative-ui:captured-svg', action: event.data.action || 'download-svg', svg: captureSvg() }, '*');
  }
  if (event.data.type === 'generative-ui:theme') {
    const vars = event.data.vars || {};
    for (const [name, value] of Object.entries(vars)) {
      document.documentElement.style.setProperty(name, String(value));
    }
    document.documentElement.dataset.theme = 'light';
    reportHeight();
  }
});

document.addEventListener('click', (event) => {
  const target = event.target && event.target.closest ? event.target.closest('a[href]') : null;
  if (!target) return;
  const href = target.getAttribute('href') || '';
  if (!href || href.startsWith('#')) return;
  event.preventDefault();
  parent.postMessage({ type: 'generative-ui:link', href }, '*');
});

window.__widgetSendMessage = (text) => {
  if (typeof text !== 'string') return;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 500) return;
  parent.postMessage({ type: 'generative-ui:send-message', text: trimmed }, '*');
};

parent.postMessage({ type: 'generative-ui:ready' }, '*');
})();`

  return `<!doctype html>
<html data-theme="${prefersDark ? 'dark' : 'light'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttr(csp)}">
<style>${styleBlock}</style>
</head>
<body>
<main id="widget-root"></main>
<script>${receiverScript}</script>
</body>
</html>`
}

/** CSS variables copied into the iframe so widgets can feel native. */
export function readWidgetThemeVars(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  const style = window.getComputedStyle(document.documentElement)
  const get = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    '--font-sans': get('--font-sans', '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'),
    '--font-mono': get('--font-mono', 'ui-monospace, SFMono-Regular, Menlo, monospace'),
    '--color-background-primary': '#ffffff',
    '--color-background-secondary': '#f8fafc',
    '--color-background-tertiary': '#f1f5f9',
    '--color-text-primary': '#111827',
    '--color-text-secondary': '#475569',
    '--color-text-tertiary': '#64748b',
    '--color-border-primary': '#cbd5e1',
    '--color-border-secondary': '#e2e8f0',
    '--color-border-tertiary': '#eef2f7',
    '--color-accent-primary': get('--blue-400', '#0285ff'),
    '--border-radius-md': get('--radius-md', '8px'),
    '--border-radius-lg': get('--radius-lg', '12px'),
  }
}

/** Base style injected before widget content. */
export function buildWidgetStyleBlock(vars: Record<string, string>): string {
  const customProps = Object.entries(vars)
    .map(([name, value]) => `${name}:${value};`)
    .join('')

  return `
:root{${customProps}color-scheme:light;}
:root[data-theme="dark"]{color-scheme:light;}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;background:#fff;color:var(--color-text-primary);font-family:var(--font-sans);font-size:14px;line-height:1.5;}
body{overflow:hidden;}
#widget-root{height:fit-content;min-height:1px;background:#fff;}
#widget-root > :not(style):not(script){max-width:100% !important;}
#widget-root > div:not([data-keep-width]),
#widget-root > section:not([data-keep-width]),
#widget-root > main:not([data-keep-width]),
#widget-root > article:not([data-keep-width]),
#widget-root > svg{width:100% !important;}
a{color:var(--color-accent-primary);text-decoration:none;}
button,input,select,textarea{font:inherit;}
button{cursor:pointer;}
svg{display:block;max-width:100%;height:auto;}
canvas{max-width:100%;}
`
}

function appendTextSegment(segments: GenerativeUiSegment[], value: string) {
  const content = value.trim()
  if (content) segments.push({ type: 'text', content })
}

function findNearbyJsonStart(text: string, start: number): number {
  const jsonStart = text.indexOf('{', start)
  if (jsonStart === -1) return -1
  const between = text.slice(start, jsonStart)
  return between.length <= 80 ? jsonStart : -1
}

function findJsonObjectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && inString) {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }

  return -1
}

function consumeTrailingFence(text: string, start: number): number {
  const trailing = text.slice(start, start + 16)
  const match = trailing.match(/^\s*\n?`{1,3}\s*/)
  return match ? start + match[0].length : start
}

function parseWidgetJson(value: string): Omit<GenerativeWidgetData, 'streaming' | 'scriptTruncated'> | null {
  try {
    const parsed = JSON.parse(value) as { title?: unknown; widget_code?: unknown }
    if (typeof parsed.widget_code !== 'string' || parsed.widget_code.trim().length < 8) return null
    return {
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
      widgetCode: parsed.widget_code,
    }
  } catch {
    return null
  }
}

function parsePartialWidget(value: string): GenerativeWidgetData | null {
  const parsed = parseWidgetJson(value)
  if (parsed) return { ...parsed, streaming: true }

  const keyIndex = value.indexOf('"widget_code"')
  if (keyIndex === -1) return null
  const colonIndex = value.indexOf(':', keyIndex)
  if (colonIndex === -1) return null
  const quoteIndex = value.indexOf('"', colonIndex + 1)
  if (quoteIndex === -1) return null

  let raw = value.slice(quoteIndex + 1)
  raw = raw.replace(/"\s*\}\s*$/, '')
  if (raw.endsWith('\\')) raw = raw.slice(0, -1)

  try {
    let widgetCode = raw
      .replace(/\\\\/g, '\u0000BACKSLASH\u0000')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_full, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\u0000BACKSLASH\u0000/g, '\\')

    let scriptTruncated = false
    const lastScript = widgetCode.lastIndexOf('<script')
    if (lastScript !== -1 && !/<script[\s\S]*?<\/script>/i.test(widgetCode.slice(lastScript))) {
      widgetCode = widgetCode.slice(0, lastScript).trim()
      scriptTruncated = true
    }
    if (widgetCode.length < 8) return null

    const titleMatch = value.match(/"title"\s*:\s*"([^"]*)"/)
    return {
      title: titleMatch?.[1],
      widgetCode,
      streaming: true,
      scriptTruncated,
    }
  } catch {
    return null
  }
}

function stripUnsafeUrls(html: string): string {
  return html.replace(URL_ATTR_RE, (match, attr: string, doubleQuoted?: string, singleQuoted?: string, unquoted?: string) => {
    const value = (doubleQuoted ?? singleQuoted ?? unquoted ?? '').trim()
    if (/^\s*javascript\s*:/i.test(value)) return ''
    if (attr.toLowerCase() !== 'src' && /^\s*data\s*:/i.test(value)) return ''
    if (attr.toLowerCase() === 'src' && /^\s*data:(?!image\/)/i.test(value)) return ''
    return match
  })
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}
