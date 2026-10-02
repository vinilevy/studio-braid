import { useState } from 'react'
import {
  ArrowDownToLine,
  ArrowRight,
  FileArchive,
  FolderOpen,
  LockKeyhole,
  Monitor,
  MoveRight,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { cleanPath, inputPathError } from '../lib/model'
import { Modal, Spinner } from './ui'
import type { Bridge } from '../hooks/useBridge'
import type { DragEvent } from 'react'

export function ProjectInput({ bridge }: { bridge: Bridge }) {
  const [dragging, setDragging] = useState(false)
  const [selector, setSelector] = useState(false)
  const disabled = bridge.busy !== null
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    if (disabled) return
    const file = event.dataTransfer.files[0] as (File & { path?: string }) | undefined
    const text =
      event.dataTransfer
        .getData('text/uri-list')
        .split('\n')
        .find((line) => line && !line.startsWith('#')) ?? event.dataTransfer.getData('text/plain')
    const candidate = cleanPath(file?.path ?? text ?? '')
    if (candidate && !inputPathError(candidate)) {
      bridge.setInputPath(candidate)
      void bridge.analyze(candidate)
    } else {
      bridge.setNotice(
        file
          ? `“${file.name}” detectado. O navegador protege o caminho do arquivo. Use o seletor local ou cole o caminho completo abaixo.`
          : 'Arraste um projeto local ou cole o caminho completo abaixo.',
      )
      document.getElementById('input-path')?.focus()
    }
  }

  return (
    <section className="input-stage stage-enter">
      <div className="hero-copy">
        <div className="eyebrow">
          <span className="tiny-line" /> DA GRAVAÇÃO À EDIÇÃO
        </div>
        <h1>
          Gravou no Screen Studio.
          <br />
          <span>Edite no DaVinci.</span>
        </h1>
        <p>
          Suas sessões reunidas. Seus canais separados.
          <br className="desktop-break" /> Uma timeline pronta para o próximo corte.
        </p>
      </div>
      <div
        className={`dropzone ${dragging ? 'dragging' : ''} ${disabled ? 'is-busy' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          if (!disabled) setDragging(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false)
        }}
        onDrop={drop}
      >
        <span className="drop-corner top-left" />
        <span className="drop-corner top-right" />
        <span className="drop-corner bottom-left" />
        <span className="drop-corner bottom-right" />
        <div className="transfer-mark" aria-hidden="true">
          <div className="transfer-source">
            <Monitor size={27} />
          </div>
          <div className="transfer-line">
            <MoveRight size={22} />
          </div>
          <div className="transfer-destination">
            <span />
            <span />
            <span />
          </div>
        </div>
        <h2>
          {bridge.busy === 'analyze'
            ? 'Conhecendo sua gravação…'
            : dragging
              ? 'Solte seu projeto aqui'
              : 'Seu próximo projeto começa aqui'}
        </h2>
        <p>
          Arraste um pacote <code>.screenstudio</code> ou <code>.screenstudio.zip</code>
        </p>
        <button
          type="button"
          className="button button-primary select-button"
          onClick={() => setSelector(true)}
          disabled={disabled}
        >
          {disabled ? <Spinner /> : <FolderOpen size={18} />} Selecionar Arquivo ou Pasta{' '}
          <ArrowRight size={17} />
        </button>
        <div className="drop-footnote">
          <LockKeyhole size={13} /> Só o caminho local. Nenhum upload.
        </div>
      </div>
      <form
        className="path-form"
        onSubmit={(event) => {
          event.preventDefault()
          void bridge.analyze()
        }}
      >
        <div className="path-divider">
          <span />
          OU USE O CAMINHO LOCAL
          <span />
        </div>
        <label htmlFor="input-path">
          Caminho do projeto <span>NA MÁQUINA EM QUE O BRIDGE ESTÁ ABERTO</span>
        </label>
        <div className="input-row">
          <FolderOpen size={17} aria-hidden="true" />
          <input
            id="input-path"
            value={bridge.inputPath}
            onChange={(event) => bridge.setInputPath(event.target.value)}
            placeholder="/Users/Levi/Gravações/Projeto.screenstudio"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            aria-describedby="path-help"
          />
          <button
            type="submit"
            className="button button-quiet"
            disabled={disabled || !bridge.inputPath.trim()}
          >
            {bridge.busy === 'analyze' ? <Spinner /> : <ArrowRight size={17} />}
            <span>Analisar</span>
          </button>
        </div>
        <p id="path-help" className="field-help">
          Mac: Finder → ⌥⌘C. Windows: clique direito → Copiar como caminho.
        </p>
        <details className="output-option">
          <summary>
            Escolher pasta de saída <span>opcional</span>
          </summary>
          <label id="initial-output-label" htmlFor="initial-output">
            Destino da exportação
          </label>
          <input
            id="initial-output"
            aria-labelledby="initial-output-label"
            aria-describedby="initial-output-help"
            className="text-input mono"
            value={bridge.outputPath}
            onChange={(event) => bridge.setOutputPath(event.target.value)}
            placeholder="Deixe vazio para usar o destino sugerido"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
          />
          <p id="initial-output-help" className="field-help">
            Use uma pasta nova ou vazia. Seus arquivos existentes não serão sobrescritos.
          </p>
        </details>
      </form>
      <div className="value-strip">
        <div>
          <ShieldCheck size={17} />
          <span>Arquivos originais intactos</span>
        </div>
        <div>
          <Sparkles size={17} />
          <span>Sincronismo verificado</span>
        </div>
        <div>
          <ArrowDownToLine size={17} />
          <span>Pronto para DaVinci Resolve</span>
        </div>
      </div>
      {selector && (
        <Modal title="Selecionar arquivo ou pasta" onClose={() => setSelector(false)}>
          <p className="modal-description">
            O seletor abre nesta máquina e informa apenas o caminho. Seu vídeo continua no disco.
          </p>
          <div className="picker-options">
            <button
              type="button"
              className="picker-option"
              onClick={() => {
                setSelector(false)
                void bridge.pick('folder')
              }}
            >
              <FolderOpen size={24} />
              <strong>Pacote Screen Studio</strong>
              <span>.screenstudio · Mac</span>
            </button>
            <button
              type="button"
              className="picker-option"
              onClick={() => {
                setSelector(false)
                void bridge.pick('zip')
              }}
            >
              <FileArchive size={24} />
              <strong>Projeto compactado</strong>
              <span>.screenstudio.zip · Windows / Mac</span>
            </button>
          </div>
          <p className="field-help">
            O projeto foi copiado de outro computador? Selecione a cópia local, não o caminho da
            máquina original.
          </p>
        </Modal>
      )}
    </section>
  )
}
