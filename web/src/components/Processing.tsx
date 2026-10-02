import { useState } from 'react'
import {
  AlertTriangle,
  Check,
  Circle,
  FileCode2,
  Radio,
  RefreshCw,
  ShieldCheck,
  Square,
} from 'lucide-react'
import { formatDuration, friendlyProgress, TRACKS } from '../lib/model'
import { Modal, Spinner, TrackIcon } from './ui'
import type { Bridge } from '../hooks/useBridge'

export function ProcessingView({ bridge }: { bridge: Bridge }) {
  const [confirm, setConfirm] = useState(false)
  const percent = bridge.progress?.percent ?? 0
  const furthest = bridge.furthestStep
  const sequence = [
    ...TRACKS.map((track) => ({
      ...track,
      absent: !bridge.analysis?.tracks.some(
        (source) => source.kind === track.kind && source.present,
      ),
    })),
    {
      kind: 'fcpxml' as const,
      label: 'Timeline DaVinci',
      file: 'FCPXML',
      action: 'Gerando timeline DaVinci FCPXML',
      absent: false,
    },
  ]
  return (
    <section className="stage-enter processing-stage">
      <div className="stage-title">
        <div>
          <div className="eyebrow">
            <span className="live-dot" />
            PROCESSANDO NESTA MÁQUINA
          </div>
          <h1>
            Separando canais.
            <br />
            <span>Preservando cada momento.</span>
          </h1>
          <p>O Bridge reconstrói as sessões e verifica o sincronismo da sua timeline.</p>
        </div>
      </div>
      <div className="processing-panel panel">
        <div className="processing-header">
          <div>
            <span className="processing-label">{bridge.analysis?.name}</span>
            <p className="mono">
              {bridge.analysis?.sessionCount} SESSÕES <span>·</span>{' '}
              {formatDuration(bridge.analysis?.durationMs ?? 0)}
            </p>
          </div>
          <div className="percentage mono">
            {percent.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}
            <span>%</span>
          </div>
        </div>
        <div
          className="progress-track"
          role="progressbar"
          aria-label="Progresso geral da exportação"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="progress-caption">
          <span role="status">{friendlyProgress(bridge.progress)}</span>
          <span className="mono">PROGRESSO REAL</span>
        </div>
        {bridge.progress?.message && (
          <details className="processing-details">
            <summary>Ver diagnóstico desta etapa</summary>
            <p>{bridge.progress.message}</p>
            <code>
              {bridge.progress.stage}
              {bridge.progress.currentTrack ? ` · ${bridge.progress.currentTrack}` : ''}
            </code>
          </details>
        )}
        <ol className="channel-timeline">
          {sequence.map((track, index) => {
            const done = !track.absent && furthest > index
            const active = !track.absent && furthest === index
            return (
              <li
                key={track.kind}
                className={`timeline-row ${done ? 'done' : active ? 'active' : ''} ${track.absent ? 'absent' : ''}`}
              >
                <span className="timeline-node">
                  {done ? <Check size={16} /> : active ? <Spinner /> : <Circle size={9} />}
                </span>
                <span className="channel-icon">
                  {track.kind === 'fcpxml' ? (
                    <FileCode2 size={19} />
                  ) : (
                    <TrackIcon kind={track.kind} size={19} />
                  )}
                </span>
                <div>
                  <strong>{active ? `${track.action}…` : track.label}</strong>
                  <code>{track.file}</code>
                </div>
                <span className="timeline-status">
                  {track.absent
                    ? 'Não gravado'
                    : done
                      ? 'Concluído'
                      : active
                        ? 'Em andamento'
                        : 'Na sequência'}
                </span>
              </li>
            )
          })}
        </ol>
        <div className="stream-status">
          <div>
            {bridge.connection === 'live' ? (
              <Radio size={15} />
            ) : (
              <RefreshCw size={15} className="spin" />
            )}
            <span>
              {bridge.connection === 'live'
                ? 'Atualizações ao vivo conectadas'
                : bridge.connection === 'reconnecting'
                  ? 'Reconectando ao serviço. A exportação pode continuar no disco.'
                  : 'Conectando às atualizações ao vivo…'}
            </span>
          </div>
          {bridge.connection === 'reconnecting' && (
            <button type="button" className="text-button" onClick={bridge.reconnect}>
              Reconectar agora
            </button>
          )}
        </div>
      </div>
      <div className="action-bar">
        <div>
          <ShieldCheck size={17} />
          <span>Mantenha esta aba aberta para acompanhar.</span>
        </div>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => setConfirm(true)}
          disabled={bridge.busy === 'cancel'}
        >
          {bridge.busy === 'cancel' ? <Spinner /> : <Square size={14} />}Cancelar
        </button>
      </div>
      {confirm && (
        <Modal title="Cancelar a preparação?" onClose={() => setConfirm(false)}>
          <div className="warning-box">
            <AlertTriangle size={19} />
            <p>O processamento será interrompido. Seus arquivos de origem permanecerão intactos.</p>
          </div>
          <p className="modal-description">
            Você poderá preparar este projeto novamente. O cancelamento só é confirmado quando o
            serviço encerrar o job.
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setConfirm(false)}
            >
              Continuar preparando
            </button>
            <button
              type="button"
              className="button button-danger"
              onClick={() => {
                setConfirm(false)
                void bridge.cancel()
              }}
            >
              Sim, cancelar
            </button>
          </div>
        </Modal>
      )}
    </section>
  )
}
