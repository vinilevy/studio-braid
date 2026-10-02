import { AlertTriangle, ArrowLeft, RefreshCw, Square, ShieldCheck } from 'lucide-react'
import { friendlyError } from '../lib/model'
import type { Bridge } from '../hooks/useBridge'

export function ErrorView({ bridge }: { bridge: Bridge }) {
  const cancelled = bridge.phase === 'cancelled'
  return (
    <section className="error-stage stage-enter">
      <div className={`error-mark ${cancelled ? 'cancelled' : ''}`}>
        {cancelled ? <Square size={27} /> : <AlertTriangle size={30} />}
      </div>
      <div className="eyebrow">
        {cancelled ? 'PROCESSAMENTO INTERROMPIDO' : 'VAMOS RESOLVER ISSO'}
      </div>
      <h1>{cancelled ? 'Preparação cancelada.' : 'Não deu para concluir.'}</h1>
      <p className="error-description">
        {cancelled
          ? 'O serviço confirmou o cancelamento. Seus arquivos originais não foram alterados. Você pode começar de novo quando quiser.'
          : friendlyError(bridge.error!)}
      </p>
      {!cancelled && (
        <details className="technical-details panel">
          <summary>Ver Detalhes Técnicos</summary>
          <dl>
            <dt>Código</dt>
            <dd className="mono">{bridge.error?.code}</dd>
            <dt>Diagnóstico do serviço</dt>
            <dd>{bridge.error?.message}</dd>
            {bridge.jobId && (
              <>
                <dt>Identificador do job</dt>
                <dd className="mono">{bridge.jobId}</dd>
              </>
            )}
          </dl>
        </details>
      )}
      <div className="error-actions">
        <button
          type="button"
          className="button button-primary"
          onClick={cancelled ? bridge.reset : bridge.back}
        >
          {cancelled ? <RefreshCw size={17} /> : <ArrowLeft size={17} />}
          {cancelled ? 'Novo Projeto' : 'Revisar projeto e destino'}
        </button>
        {!cancelled && (
          <button type="button" className="button button-ghost" onClick={bridge.reset}>
            Escolher outro projeto
          </button>
        )}
      </div>
      <div className="closing-note">
        <ShieldCheck size={16} />
        Nenhum arquivo de origem foi modificado.
      </div>
    </section>
  )
}
