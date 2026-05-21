/**
 * Clipboard and lightweight artifact export helpers used by chat renderers.
 */

export async function writeClipboardText(text: string): Promise<boolean> {
  if (!text.trim()) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    textarea.style.top = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    try {
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      textarea.remove()
    }
  }
}

export function downloadSvgFile(svg: string, title: string) {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${safeFileName(title)}.svg`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function copySvgAsPng(svg: string): Promise<boolean> {
  if (window.desktop?.copySvgToClipboard) {
    try {
      const copied = await window.desktop.copySvgToClipboard(svg)
      if (copied) return true
    } catch {
      /* fall through to renderer fallback */
    }
  }

  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': renderSvgToPngBlob(svg) })])
      return true
    } catch {
      /* fall through to desktop PNG bridge fallback */
    }
  }

  try {
    const pngBlob = await renderSvgToPngBlob(svg)
    if (window.desktop?.copyPngToClipboard) {
      return window.desktop.copyPngToClipboard(await blobToDataUrl(pngBlob))
    }
    return false
  } catch {
    return false
  }
}

function safeFileName(value: string): string {
  const next = value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
  return next || 'chat-artifact'
}

async function renderSvgToPngBlob(svg: string): Promise<Blob> {
  const size = readSvgSize(svg)
  const scale = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(size.width * scale))
  canvas.height = Math.max(1, Math.round(size.height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas unavailable')

  context.scale(scale, scale)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, size.width, size.height)

  const image = await loadSvgImage(svg)
  context.drawImage(image, 0, 0, size.width, size.height)

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('PNG export failed'))
    }, 'image/png')
  })
}

function readSvgSize(svg: string): { width: number; height: number } {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const svgNode = doc.documentElement
  const width = readSvgLength(svgNode.getAttribute('width'))
  const height = readSvgLength(svgNode.getAttribute('height'))
  const viewBox = svgNode.getAttribute('viewBox')?.trim().split(/\s+/).map(Number) ?? []
  return {
    width: width || (Number.isFinite(viewBox[2]) ? viewBox[2] : 920),
    height: height || (Number.isFinite(viewBox[3]) ? viewBox[3] : 320),
  }
}

function readSvgLength(value: string | null): number {
  if (!value) return 0
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('SVG image load failed'))
    }
    image.src = url
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error ?? new Error('Blob read failed'))
    reader.readAsDataURL(blob)
  })
}
