import { useEffect, useId, useRef } from 'react'
import {
  Check,
  ChevronRight,
  Copy,
  LoaderCircle,
  Monitor,
  Video,
  Mic,
  Volume2,
  X,
} from 'lucide-react'
import { copyText } from '../lib/model'
import type { TrackKind } from '../lib/types'
import type { ReactNode } from 'react'

export function TrackIcon({ kind, size = 20 }: { kind: TrackKind; size?: number }) {
  const Icon = { display: Monitor, webcam: Video, microphone: Mic, systemAudio: Volume2 }[kind]
  return <Icon size={size} aria-hidden="true" />
}

export function Spinner() {
  return <LoaderCircle size={18} className="spin" aria-hidden="true" />
}

export function Steps({ active }: { active: number }) {
  return (
    <nav aria-label="Étapas de preparação" className="workflow-steps">
      {['Selecionar', 'Verificar', 'Preparar', 'Editar'].map((label, index) => (
        <div
          key={label}
          className={`workflow-step ${index === active ? 'active' : ''} ${index < active ? 'done' : ''}`}
          aria-current={index === active ? 'step' : undefined}
        >
          <span className="step-number">
            {index < active ? <Check size={13} /> : `0${index + 1}`}
          </span>
          <span>{label}</span>
          {index < 3 && <ChevronRight size={14} className="step-chevron" aria-hidden="true" />}
        </div>
      ))}
    </nav>
  )
}

export function CopyButton({
  value,
  label,
  onNotice,
}: {
  value: string
  label: string
  onNotice: (message: string) => void
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      onClick={() => {
        void copyText(value)
          .then(() => onNotice('Copiado para a área de transferência.'))
          .catch((error) => onNotice((error as Error).message))
      }}
    >
      <Copy size={17} />
    </button>
  )
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string
  children: ReactNode
  onClose: () => void
}) {
  const titleId = useId()
  const ref = useRef<HTMLDialogElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = ref.current
    dialog?.showModal()
    return () => {
      dialog?.close()
      previous?.focus()
    }
  }, [])
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="modal"
      onCancel={(event) => {
        event.preventDefault()
        close.current()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close.current()
      }}
    >
      <div className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label="Fechar diálogo" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  )
}
