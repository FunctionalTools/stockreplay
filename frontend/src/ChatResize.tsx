import { useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { MoveDiagonal2 } from 'lucide-react'

type Size = { width: number; height: number }
type Drag = Size & { x: number; y: number; pointerId: number; moved: boolean }
const preference = 'stockreplay.assistant-size.v1'

function apply(panel: HTMLElement, size: Size | null) {
  for (const axis of ['width', 'height'] as const) {
    const property = '--chat-' + axis
    if (size) panel.style.setProperty(property, Math.max(1, Math.round(size[axis])) + 'px')
    else panel.style.removeProperty(property)
  }
}

function readSize(): Size | null {
  try {
    const size = JSON.parse(localStorage.getItem(preference) || 'null')
    if (
      Number.isFinite(size?.width) &&
      Number.isFinite(size.height) &&
      size.width > 0 &&
      size.height > 0
    )
      return size
  } catch {
    /* The control still works with browser storage disabled. */
  }
  return null
}

function saveSize(size: Size | null) {
  try {
    if (size) localStorage.setItem(preference, JSON.stringify(size))
    else localStorage.removeItem(preference)
  } catch {
    /* Keep the current size for this window. */
  }
}

const presetEvent = 'stockreplay:assistant-size'
export function setAssistantSize(preset: 'compact' | 'large') {
  const size = preset === 'large' ? { width: 660, height: 680 } : null
  saveSize(size)
  window.dispatchEvent(new CustomEvent(presetEvent, { detail: size }))
}

export function ChatResize() {
  const handle = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement | null>(null)
  const drag = useRef<Drag | null>(null)
  const suppressClick = useRef(false)
  useLayoutEffect(() => {
    panel.current = handle.current?.closest('.chat-panel') ?? null
    if (panel.current) apply(panel.current, readSize())
    const onPreset = (e: Event) => {
      if (panel.current) apply(panel.current, (e as CustomEvent<Size | null>).detail)
    }
    window.addEventListener(presetEvent, onPreset)
    return () => window.removeEventListener(presetEvent, onPreset)
  }, [])

  function finish(size: Size) {
    const el = panel.current
    if (!el) return
    apply(el, size)
    const { width, height } = el.getBoundingClientRect()
    saveSize({ width, height })
  }

  function resize(e: PointerEvent<HTMLButtonElement>) {
    const start = drag.current
    if (!start || e.pointerId !== start.pointerId || !panel.current) return
    const dx = start.x - e.clientX,
      dy = start.y - e.clientY
    if (!start.moved && Math.abs(dx) + Math.abs(dy) < 3) return
    start.moved = true
    apply(panel.current, { width: start.width + dx, height: start.height + dy })
  }

  function onKey(e: KeyboardEvent<HTMLButtonElement>) {
    const rect = panel.current?.getBoundingClientRect()
    if (!rect) return
    const step = e.shiftKey ? 64 : 16
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    }
    if (e.key === 'Home') setAssistantSize('compact')
    else if (deltas[e.key]) {
      const [dx, dy] = deltas[e.key]
      finish({ width: rect.width + dx, height: rect.height + dy })
    } else return
    e.preventDefault()
  }
  return (
    <button
      ref={handle}
      type="button"
      className="chat-resize"
      aria-label="Resize assistant"
      title="Drag to resize. Click for large or compact. Arrow keys adjust size. Home resets."
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home"
      onKeyDown={onKey}
      onPointerDown={(e) => {
        if (!e.isPrimary || e.button !== 0 || !panel.current) return
        const { width, height } = panel.current.getBoundingClientRect()
        suppressClick.current = false
        drag.current = {
          x: e.clientX,
          y: e.clientY,
          width,
          height,
          pointerId: e.pointerId,
          moved: false,
        }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={resize}
      onPointerUp={(e) => {
        const start = drag.current
        if (!start || start.pointerId !== e.pointerId) return
        resize(e)
        if (start.moved && panel.current) {
          suppressClick.current = true
          const { width, height } = panel.current.getBoundingClientRect()
          finish({ width, height })
        }
        drag.current = null
      }}
      onLostPointerCapture={() => {
        if (drag.current && panel.current) apply(panel.current, readSize())
        drag.current = null
      }}
      onClick={(e) => {
        if (!panel.current || (e.detail && suppressClick.current)) return
        const customized = panel.current.style.getPropertyValue('--chat-width') !== ''
        setAssistantSize(customized ? 'compact' : 'large')
      }}
    >
      <MoveDiagonal2 size={17} aria-hidden="true" />
    </button>
  )
}
