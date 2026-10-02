import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Clock3,
  FolderOpen,
  HardDrive,
  Layers3,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  ChevronDown,
  Video,
  Sparkles,
} from 'lucide-react'
import { formatBytes, formatDuration, TRACKS } from '../lib/model'
import { CAMERA_RESOLUTION_OPTIONS, QUALITY_OPTIONS } from '../lib/export-settings'
import type { CameraResolution, ImageQuality } from '../lib/export-settings'
import { Spinner, TrackIcon } from './ui'
import type { Bridge } from '../hooks/useBridge'

export function AnalysisView({ bridge }: { bridge: Bridge }) {
  const project = bridge.analysis!
  const disk = project.diskSpace
  const diskState = bridge.analysisDirty
    ? 'unknown'
    : disk.sufficient === true
      ? 'ok'
      : disk.sufficient === false
        ? 'bad'
        : 'unknown'
  const unavailable =
    bridge.busy !== null || !bridge.ready || disk.sufficient === false || bridge.analysisDirty
  return (
    <section className="stage-enter">
      <div className="stage-title">
        <div>
          <div className="eyebrow">PROJETO ANALISADO</div>
          <h1>
            Vamos preparar <span>seu próximo corte.</span>
          </h1>
          <p>Confira as fontes e o destino. O restante fica com o Bridge.</p>
        </div>
        <button
          type="button"
          className="button button-ghost"
          onClick={bridge.reset}
          disabled={bridge.busy !== null}
        >
          <ArrowLeft size={16} />
          Trocar projeto
        </button>
      </div>
      <div className="project-heading panel">
        <div className="project-avatar">
          <FolderOpen size={26} />
        </div>
        <div className="project-name">
          <h2>{project.name}</h2>
          <p className="mono break-path">{project.inputPath}</p>
        </div>
        <div className="project-metrics">
          <span className="session-badge">
            <Layers3 size={15} />
            Sessões detectadas: {project.sessionCount}
          </span>
          <span className="duration">
            <Clock3 size={15} />
            <strong className="mono">{formatDuration(project.durationMs)}</strong>
            <small>DURAÇÃO ESTIMADA</small>
          </span>
        </div>
      </div>
      <div className="section-heading">
        <h2>Fontes da gravação</h2>
        <span>{project.tracks.filter((track) => track.present).length} CANAIS DETECTADOS</span>
      </div>
      <div className="track-grid">
        {TRACKS.map((info) => {
          const track = project.tracks.find((item) => item.kind === info.kind)
          const present = track?.present === true
          return (
            <article
              key={info.kind}
              className={`track-card panel ${present ? '' : 'track-absent'}`}
            >
              <div className="track-card-top">
                <span className="track-icon">
                  <TrackIcon kind={info.kind} />
                </span>
                <span className={`track-status ${present ? 'present' : ''}`}>
                  {present ? (
                    <>
                      <span className="status-dot" />
                      Detectado
                    </>
                  ) : (
                    'Não gravado'
                  )}
                </span>
              </div>
              <h3>{info.label}</h3>
              <p className="track-format">
                {present
                  ? info.kind === 'webcam'
                    ? 'Será transcodificada para H.264 para DaVinci'
                    : info.detail
                  : 'Esta fonte não faz parte do projeto.'}
              </p>
              <div className="track-card-meta">
                <code>{info.file}</code>
                <span className="mono">{present ? formatDuration(track.durationMs) : '—'}</span>
              </div>
              {present && (
                <div className="track-extra">
                  {info.kind === 'display'
                    ? 'Resolução e FPS verificados na exportação'
                    : `${track.sessionCount} ${track.sessionCount === 1 ? 'sessão' : 'sessões'} na timeline`}
                </div>
              )}
            </article>
          )
        })}
      </div>
      <section className="export-settings panel" aria-labelledby="export-settings-title">
        <div className="export-settings-heading">
          <div>
            <SlidersHorizontal size={18} />
            <h2 id="export-settings-title">Configurações de exportação</h2>
          </div>
          <span
            className={`export-profile-badge ${bridge.cameraResolution === '4k' ? 'master' : ''}`}
          >
            {bridge.cameraResolution === '4k'
              ? '4K UPSCALE MASTER'
              : bridge.cameraResolution === 'native'
                ? 'RESOLUÇÃO NATIVA'
                : '1080p FULL HD'}
          </span>
        </div>
        <div className="export-settings-grid">
          <div className={`export-setting ${bridge.cameraResolution === '4k' ? 'is-master' : ''}`}>
            <label htmlFor="camera-resolution">
              <Video size={16} />
              Resolução da câmera
            </label>
            <div className="select-wrap">
              <select
                id="camera-resolution"
                value={bridge.cameraResolution}
                onChange={(event) =>
                  bridge.setCameraResolution(event.target.value as CameraResolution)
                }
                disabled={bridge.busy !== null}
                aria-describedby="camera-resolution-help"
              >
                {CAMERA_RESOLUTION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={16} aria-hidden="true" />
            </div>
            <p id="camera-resolution-help" className="field-help">
              {
                CAMERA_RESOLUTION_OPTIONS.find((option) => option.value === bridge.cameraResolution)
                  ?.description
              }
            </p>
          </div>
          <div className="export-setting">
            <label htmlFor="image-quality">
              <Sparkles size={16} />
              Qualidade de imagem
              {bridge.quality === 'maximum' && (
                <span className="quality-recommended" aria-hidden="true">
                  RECOMENDADO
                </span>
              )}
            </label>
            <div className="select-wrap">
              <select
                id="image-quality"
                value={bridge.quality}
                onChange={(event) => bridge.setQuality(event.target.value as ImageQuality)}
                disabled={bridge.busy !== null}
                aria-describedby="image-quality-help"
              >
                {QUALITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={16} aria-hidden="true" />
            </div>
            <p id="image-quality-help" className="field-help">
              {QUALITY_OPTIONS.find((option) => option.value === bridge.quality)?.description}
            </p>
          </div>
        </div>
        {!project.tracks.some((track) => track.kind === 'webcam' && track.present) && (
          <p className="field-help">
            Não há câmera gravada neste projeto. A resolução escolhida não cria uma nova faixa.
          </p>
        )}
        {bridge.exportSettingsDirty && (
          <p className="export-settings-notice" role="status">
            <RefreshCw size={14} />
            Perfil alterado. Atualize a estimativa de disco abaixo antes de preparar.
          </p>
        )}
      </section>
      <div className="destination-panel panel">
        <div className="destination-heading">
          <div>
            <FolderOpen size={18} />
            <h2>Destino da exportação</h2>
          </div>
          <span className="subtle-tag">ORIGINAIS PRESERVADOS</span>
        </div>
        <label htmlFor="output-path" className="sr-only">
          Pasta de saída
        </label>
        <div className="output-input-row">
          <input
            id="output-path"
            className="text-input mono"
            value={bridge.outputPath}
            onChange={(event) => bridge.setOutputPath(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={bridge.busy !== null}
          />
          <button
            type="button"
            className="button button-quiet"
            onClick={() => {
              void bridge.analyze()
            }}
            disabled={bridge.busy !== null}
          >
            {bridge.busy === 'analyze' ? <Spinner /> : <RefreshCw size={15} />}
            {bridge.exportSettingsDirty ? 'Atualizar estimativa' : 'Verificar destino'}
          </button>
        </div>
        <p className="field-help">
          Use uma pasta nova ou vazia. Mídias, timeline e relatório serão salvos juntos.
        </p>
        <div className={`disk-check ${diskState}`}>
          <HardDrive size={19} />
          <div>
            <strong>
              {diskState === 'ok'
                ? 'Espaço suficiente'
                : diskState === 'bad'
                  ? 'Espaço insuficiente'
                  : bridge.analysisDirty
                    ? bridge.outputDirty
                      ? 'Verifique o novo destino'
                      : 'Atualize a estimativa do perfil'
                    : 'Espaço não verificado'}
            </strong>
            <p>
              {bridge.analysisDirty ? (
                bridge.outputDirty ? (
                  'Atualize a análise para checar o espaço nesta pasta antes de preparar.'
                ) : (
                  'A resolução ou qualidade mudou. Verifique a estimativa para o perfil selecionado.'
                )
              ) : (
                <>
                  <span className="mono">{formatBytes(disk.availableBytes)}</span> disponíveis{' '}
                  <span className="disk-separator">/</span>{' '}
                  <span className="mono">{formatBytes(disk.estimatedRequiredBytes)}</span>{' '}
                  necessários (estimativa da API)
                </>
              )}
            </p>
          </div>
          {diskState === 'ok' ? <Check size={18} /> : <AlertTriangle size={18} />}
        </div>
      </div>
      {project.warnings.length > 0 && (
        <div className="warning-box">
          <AlertTriangle size={18} />
          <div>
            <strong>Observações sobre este projeto</strong>
            <ul>
              {project.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {!bridge.ready && (
        <p className="action-warning">
          O serviço local precisa estar pronto, com FFmpeg e FFprobe disponíveis.
        </p>
      )}
      <div className="action-bar">
        <div>
          <ShieldCheck size={17} />
          <span>Reconstrução local. Sem alterar os originais.</span>
        </div>
        <button
          type="button"
          className="button button-primary button-large"
          onClick={() => {
            void bridge.start()
          }}
          disabled={unavailable}
        >
          {bridge.busy === 'start' ? <Spinner /> : <Layers3 size={19} />}PREPARAR PARA DAVINCI
          <ArrowRight size={18} />
        </button>
      </div>
    </section>
  )
}
