import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X, AlertCircle, LoaderCircle } from 'lucide-react'

export function Modal({
  title,
  children,
  close,
  wide = false,
}: {
  title: string
  children: ReactNode
  close: () => void
  wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null),
    label = useId()
  useEffect(() => {
    const d = ref.current!
    d.showModal()
    return () => d.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className={wide ? 'modal wide' : 'modal'}
      aria-labelledby={label}
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const box = e.currentTarget.getBoundingClientRect()
          if (
            e.clientX < box.left ||
            e.clientX > box.right ||
            e.clientY < box.top ||
            e.clientY > box.bottom
          )
            close()
        }
      }}
    >
      <div className="modal-head">
        <h2 id={label}>{title}</h2>
        <button aria-label="Close dialog" className="icon-btn" onClick={close}>
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  )
}
export function ErrorBox({ text }: { text: string }) {
  return text ? (
    <div className="error-box" role="alert">
      <AlertCircle size={16} />
      <span>{text}</span>
    </div>
  ) : null
}
export function Busy({ text }: { text: string }) {
  return (
    <span className="inline">
      <LoaderCircle size={15} className="spin" />
      {text}
    </span>
  )
}
export function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{name}</span>
      {children}
    </label>
  )
}
export function Empty({
  title,
  body,
  children,
}: {
  title: string
  body: string
  children?: ReactNode
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{body}</p>
      {children}
    </div>
  )
}
