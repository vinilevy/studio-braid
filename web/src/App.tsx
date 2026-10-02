import { useEffect, useRef } from 'react'
import { Monitor, ShieldCheck, X, ArrowUpRight, WifiOff } from 'lucide-react'
import { useBridge } from './hooks/useBridge'
import { Steps } from './components/ui'
import { ProjectInput } from './components/ProjectInput'
import { AnalysisView } from './components/ProjectAnalysis'
import { ProcessingView } from './components/Processing'
import { SuccessView } from './components/Success'
import { ErrorView } from './components/ErrorView'

export default function App() {
  const bridge = useBridge()
  const mainRef = useRef<HTMLElement>(null)
  const previousPhase = useRef(bridge.phase)
  useEffect(() => {
    if (bridge.phase !== previousPhase.current) {
      const heading = mainRef.current?.querySelector('h1')
      heading?.setAttribute('tabindex', '-1')
      heading?.focus({ preventScroll: true })
      previousPhase.current = bridge.phase
    }
  }, [bridge.phase])
  const activeStep =
    bridge.phase === 'input'
      ? 0
      : bridge.phase === 'analysis'
        ? 1
        : bridge.phase === 'processing'
          ? 2
          : bridge.phase === 'success'
            ? 3
            : bridge.analysis
              ? 1
              : 0
  return (
    <div className="app-shell">
      <header className="app-header">
        <a
          href="/"
          className="brand"
          onClick={(event) => {
            event.preventDefault()
            if (bridge.phase !== 'processing' && !bridge.busy) bridge.reset()
          }}
          aria-label="Screen Studio Bridge — início"
        >
          <span className="brand-mark">
            <Monitor size={21} />
            <span />
          </span>
          <span>
            SCREEN STUDIO <strong>BRIDGE</strong>
          </span>
        </a>
        <div className="header-right">
          <span className="privacy-badge">
            <ShieldCheck size={14} />
            <span>
              100% Local <i>— Nenhum vídeo é enviado para a nuvem</i>
            </span>
          </span>
          <div
            className={`service-status ${bridge.ready ? 'online' : bridge.checkingStatus ? 'checking' : 'offline'}`}
            title={`FFmpeg: ${bridge.status?.ffmpeg.available ? 'disponível' : 'indisponível'} · FFprobe: ${bridge.status?.ffprobe.available ? 'disponível' : 'indisponível'}`}
          >
            <span className="status-dot" />
            {bridge.checkingStatus
              ? 'Conectando'
              : bridge.ready
                ? 'Serviço pronto'
                : bridge.status
                  ? 'Requer configuração'
                  : 'Serviço offline'}
          </div>
        </div>
      </header>
      <main ref={mainRef} id="main-content" className="main-content">
        <div className="workspace-top">
          <div className="workspace-label">
            <span className="workspace-dot" />
            WORKSPACE LOCAL
          </div>
          <Steps active={activeStep} />
        </div>
        {!bridge.checkingStatus && !bridge.ready && bridge.phase === 'input' && (
          <div className="service-banner" role="status">
            <WifiOff size={17} />
            <span>
              {bridge.status
                ? 'FFmpeg ou FFprobe indisponível. Verifique a configuração do serviço antes de exportar.'
                : 'O serviço local ainda não está conectado. Abra o Bridge em 127.0.0.1:3847 nesta máquina.'}
            </span>
          </div>
        )}
        {bridge.notice && (
          <div className="notice" role="status">
            <span>{bridge.notice}</span>
            <button
              type="button"
              className="icon-button"
              onClick={() => bridge.setNotice('')}
              aria-label="Dispensar aviso"
            >
              <X size={16} />
            </button>
          </div>
        )}
        {bridge.phase === 'input' && <ProjectInput bridge={bridge} />}
        {bridge.phase === 'analysis' && <AnalysisView bridge={bridge} />}
        {bridge.phase === 'processing' && <ProcessingView bridge={bridge} />}
        {bridge.phase === 'success' && <SuccessView bridge={bridge} />}
        {(bridge.phase === 'error' || bridge.phase === 'cancelled') && (
          <ErrorView bridge={bridge} />
        )}
      </main>
      <footer className="app-footer">
        <span>
          SCREEN STUDIO <strong>→</strong> DAVINCI RESOLVE
        </span>
        <div>
          <span className="footer-local">
            <span className="status-dot" />
            SEU DISCO. SEU CONTROLE.
          </span>
          <span className="mono">
            BRIDGE {bridge.status?.version ? `v${bridge.status.version}` : 'LOCAL'}
            <ArrowUpRight size={11} aria-hidden="true" />
          </span>
        </div>
      </footer>
    </div>
  )
}
