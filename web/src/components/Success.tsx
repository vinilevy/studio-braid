import { useState } from 'react'
import {
  ArrowRight,
  Check,
  CheckCheck,
  ClipboardList,
  FileCode2,
  FolderOpen,
  Plus,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react'
import { api, asApiError } from '../lib/api'
import { copyText, formatPreciseDuration, formatFrameRate, TRACKS } from '../lib/model'
import { CopyButton, Spinner, TrackIcon } from './ui'
import type { Bridge } from '../hooks/useBridge'

export function SuccessView({ bridge }: { bridge: Bridge }) {
  const [opening, setOpening] = useState(false)
  const result = bridge.result!
  const report = result.syncReport
  const deviation = Math.max(report.maxDeviationMs, report.interTrackDeviationMs)
  const valid =
    report.status === 'ok' && Number.isFinite(deviation) && deviation < report.toleranceMs
  const copyReport = () => {
    void copyText(JSON.stringify(report, null, 2))
      .then(() => bridge.setNotice('Relatório técnico copiado.'))
      .catch((error) => bridge.setNotice((error as Error).message))
  }
  const openOutput = async () => {
    if (!bridge.jobId) return
    setOpening(true)
    try {
      await api.openOutput(bridge.jobId)
      bridge.setNotice('A pasta de saída foi aberta nesta máquina.')
    } catch (error) {
      bridge.setNotice(
        `Não foi possível abrir a pasta automaticamente. Copie o caminho e abra no Finder ou Explorador. ${asApiError(error).message}`,
      )
    } finally {
      setOpening(false)
    }
  }
  return (
    <section className="stage-enter success-stage">
      <div className={`success-mark ${valid ? '' : 'unverified'}`}>
        {valid ? <Check size={33} /> : <TriangleAlert size={33} />}
      </div>
      <div className="success-heading">
        <div className="eyebrow">
          {valid ? 'PRONTO PARA O PRÓXIMO CORTE' : 'EXPORTAÇÃO ENCERRADA'}
        </div>
        <h1>
          {valid ? (
            <>
              Sua timeline.
              <br />
              <span>Pronta para editar.</span>
            </>
          ) : (
            <>
              Confira o relatório.
              <br />
              <span>O sincronismo requer atenção.</span>
            </>
          )}
        </h1>
        <p>
          {result.manifest.projectName} <span>·</span>{' '}
          <span className="mono">{formatPreciseDuration(result.manifest.timelineDurationMs)}</span>
        </p>
        <div className={`sync-badge ${valid ? '' : 'failed'}`}>
          {valid ? <CheckCheck size={17} /> : <TriangleAlert size={17} />}
          <strong>{valid ? 'Sincronismo validado' : 'Sincronismo não aprovado'}</strong>
          <span>
            Desvio máximo: {deviation.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} ms
          </span>
        </div>
        <p className="sync-scope">
          Verificação de timestamps e frames. Não substitui a revisão perceptual de fala e ação.
        </p>
      </div>
      <div className="result-panel panel">
        <div className="section-heading">
          <h2>Mídias geradas</h2>
          <span>{result.manifest.media.length} ARQUIVOS</span>
        </div>
        <div className="media-list">
          {result.manifest.media.map((media) => {
            const info = TRACKS.find((track) => track.kind === media.kind)!
            const trackReport = report.tracks.find((track) => track.kind === media.kind)
            const probe = trackReport?.probe
            const fps = formatFrameRate(probe?.averageFrameRate ?? probe?.frameRate)
            const videoMeta =
              probe?.width && probe.height
                ? `${probe.width} × ${probe.height}${fps ? ` · ${fps} FPS${probe.averageFrameRate ? ' médios' : ''}` : ''}`
                : null
            return (
              <div className="media-row" key={media.kind}>
                <span className="track-icon">
                  <TrackIcon kind={media.kind} />
                </span>
                <div>
                  <strong>
                    {info.label}
                    <code>{media.file.split(/[\\/]/).pop()}</code>
                  </strong>
                  <span className="media-detail">
                    {videoMeta ??
                      `${media.codec}${probe?.sampleRate ? ` · ${(probe.sampleRate / 1000).toLocaleString('pt-BR')} kHz` : ''}`}
                  </span>
                </div>
                <span
                  className="mono media-duration"
                  title={`${media.durationMs.toLocaleString('pt-BR', { maximumFractionDigits: 6 })} ms no relatório`}
                >
                  {formatPreciseDuration(media.durationMs)}
                </span>
                <Check size={17} className="media-check" />
              </div>
            )
          })}
        </div>
        {result.manifest.missingTracks.length > 0 && (
          <p className="field-help">
            Não gravados:{' '}
            {result.manifest.missingTracks
              .map((kind) => TRACKS.find((track) => track.kind === kind)?.label)
              .join(', ')}
            . Nenhuma mídia artificial foi criada.
          </p>
        )}
        <div className="fcpxml-result">
          <FileCode2 size={24} />
          <div>
            <strong>Timeline DaVinci · FCPXML</strong>
            <p>Importe este arquivo no DaVinci Resolve e comece a editar.</p>
            <code className="break-path">{result.fcpxmlPath}</code>
          </div>
          <CopyButton
            value={result.fcpxmlPath}
            label="Copiar caminho da timeline FCPXML"
            onNotice={bridge.setNotice}
          />
        </div>
      </div>
      {report.warnings.length > 0 && (
        <div className="warning-box">
          <TriangleAlert size={18} />
          <div>
            <strong>Observações da verificação</strong>
            <ul>
              {report.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className="output-result panel">
        <div>
          <FolderOpen size={19} />
          <strong>Pasta de saída</strong>
          <CopyButton
            value={result.outputPath}
            label="Copiar caminho da pasta de saída"
            onNotice={bridge.setNotice}
          />
        </div>
        <code className="break-path selectable">{result.outputPath}</code>
        <button
          type="button"
          className="button button-primary"
          onClick={() => {
            void openOutput()
          }}
          disabled={opening}
        >
          {opening ? <Spinner /> : <FolderOpen size={17} />}Abrir Pasta de Saída
          <ArrowRight size={17} />
        </button>
      </div>
      <div className="success-actions">
        <button type="button" className="button button-secondary" onClick={copyReport}>
          <ClipboardList size={17} />
          Copiar Relatório Técnico
        </button>
        <button type="button" className="button button-ghost" onClick={bridge.reset}>
          <Plus size={17} />
          Novo Projeto
        </button>
      </div>
      <div className="closing-note">
        <ShieldCheck size={16} />
        Tudo aconteceu no seu computador. Seus originais estão intactos.
      </div>
    </section>
  )
}
