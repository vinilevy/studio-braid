import { useCallback, useEffect, useRef, useState } from 'react'
import { api, asApiError } from '../lib/api'
import { DEFAULT_EXPORT_SETTINGS } from '../lib/export-settings'
import type { CameraResolution, ExportSettings, ImageQuality } from '../lib/export-settings'
import {
  cleanPath,
  inputPathError,
  isAbsolutePath,
  parseProgress,
  progressStep,
} from '../lib/model'
import type {
  ApiError,
  ExportResult,
  JobSnapshot,
  ProgressEvent,
  ProjectAnalysis,
  ServerStatus,
} from '../lib/types'

export type Phase = 'input' | 'analysis' | 'processing' | 'success' | 'error' | 'cancelled'
export type Busy = 'analyze' | 'start' | 'pick' | 'cancel' | null

export function useBridge() {
  const [phase, setPhase] = useState<Phase>('input')
  const [inputPath, setInputPath] = useState('')
  const [outputPath, setOutputPath] = useState('')
  const [cameraResolution, setCameraResolution] = useState<CameraResolution>(
    DEFAULT_EXPORT_SETTINGS.cameraResolution,
  )
  const [quality, setQuality] = useState<ImageQuality>(DEFAULT_EXPORT_SETTINGS.quality)
  const [analyzedSettings, setAnalyzedSettings] = useState<ExportSettings | null>(null)
  const [analysis, setAnalysis] = useState<ProjectAnalysis | null>(null)
  const [result, setResult] = useState<ExportResult | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [checkingStatus, setCheckingStatus] = useState(true)
  const [busy, setBusy] = useState<Busy>(null)
  const [notice, setNotice] = useState('')
  const [jobId, setJobId] = useState<string | null>(null)
  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  const [furthestStep, setFurthestStep] = useState(-1)
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting'>('connecting')
  const [streamAttempt, setStreamAttempt] = useState(0)
  const operation = useRef(false)
  const analyzingController = useRef<AbortController | null>(null)
  const ready = status?.status === 'ok' && status.ffmpeg.available && status.ffprobe.available
  const outputDirty = analysis !== null && cleanPath(outputPath) !== analysis.outputPath
  const exportSettingsDirty =
    analysis !== null &&
    (analyzedSettings?.cameraResolution !== cameraResolution ||
      analyzedSettings?.quality !== quality)
  const analysisDirty = outputDirty || exportSettingsDirty

  useEffect(() => {
    let alive = true
    let controller: AbortController | null = null
    const refresh = async () => {
      controller?.abort()
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 8_000)
      try {
        const next = await api.status(controller.signal)
        if (alive) setStatus(next)
      } catch {
        if (alive) setStatus(null)
      } finally {
        clearTimeout(timeout)
        if (alive) setCheckingStatus(false)
      }
    }
    void refresh()
    const interval = setInterval(() => {
      void refresh()
    }, 10_000)
    return () => {
      alive = false
      controller?.abort()
      clearInterval(interval)
      analyzingController.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!jobId || phase !== 'processing') return
    let disposed = false
    let terminal = false
    let snapshotPending = false
    let sseRevision = 0
    let lastEventId = -1
    let highestPercent = progress?.percent ?? -1
    let highestStep = furthestStep
    const snapshotController = new AbortController()
    const source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`)
    setConnection('connecting')
    const receive = (next: ProgressEvent) => {
      if (disposed || terminal) return
      const isTerminal =
        ['completed', 'failed', 'cancelled'].includes(next.state ?? '') ||
        ['complete', 'failed', 'cancelled'].includes(next.stage)
      const nextStep = progressStep(next)
      // Snapshots and replay can arrive behind a newer stream update.
      if (
        !isTerminal &&
        (next.percent < highestPercent || (nextStep >= 0 && nextStep < highestStep))
      )
        return
      highestPercent = Math.max(highestPercent, next.percent)
      highestStep = Math.max(highestStep, nextStep)
      setProgress(next)
      setFurthestStep((previous) => Math.max(previous, progressStep(next)))
      if (next.state === 'completed' || next.stage === 'complete') {
        terminal = true
        source.close()
        if (next.result) {
          setResult(next.result)
          setPhase('success')
        } else {
          setError({
            code: 'MISSING_RESULT',
            message: 'A exportação terminou, mas o relatório final não foi recebido.',
          })
          setPhase('error')
        }
      } else if (next.state === 'cancelled' || next.stage === 'cancelled') {
        terminal = true
        source.close()
        setPhase('cancelled')
      } else if (next.state === 'failed' || next.stage === 'failed') {
        terminal = true
        source.close()
        setError(next.error ?? { code: 'EXPORT_FAILED', message: next.message })
        setPhase('error')
      }
    }
    const reconcile = async () => {
      if (disposed || terminal || snapshotPending) return
      snapshotPending = true
      const revisionAtRequest = sseRevision
      try {
        const snapshot = await api.snapshot(jobId, snapshotController.signal)
        if (
          sseRevision !== revisionAtRequest &&
          !['completed', 'failed', 'cancelled'].includes(snapshot.state)
        )
          return
        receive({
          ...snapshot.progress,
          state: snapshot.state,
          result: snapshot.result ?? snapshot.progress.result,
          error: snapshot.error ?? snapshot.progress.error,
        })
      } catch {
        /* A disconnected stream is not evidence that the export failed. */
      } finally {
        snapshotPending = false
      }
    }
    source.onopen = () => {
      if (!disposed && !terminal) {
        setConnection('live')
        void reconcile()
      }
    }
    source.onmessage = (message) => {
      const next = parseProgress(message.data)
      const id = message.lastEventId ? Number(message.lastEventId) : NaN
      if (Number.isFinite(id) && id <= lastEventId) return
      if (Number.isFinite(id)) lastEventId = id
      sseRevision++
      if (next) {
        setConnection('live')
        receive(next)
      } else
        setNotice('Recebemos uma atualização inválida. Aguardando o próximo status do serviço.')
    }
    source.onerror = () => {
      if (!disposed && !terminal) {
        setConnection('reconnecting')
        void reconcile()
      }
    }
    // The snapshot also recovers a terminal event lost during a disconnect.
    void reconcile()
    const interval = setInterval(() => {
      void reconcile()
    }, 10_000)
    return () => {
      disposed = true
      source.close()
      snapshotController.abort()
      clearInterval(interval)
    }
  }, [jobId, phase, streamAttempt])

  useEffect(() => {
    if (phase !== 'processing') return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [phase])

  const analyze = useCallback(
    async (selectedPath?: string) => {
      if (operation.current) return
      const input = cleanPath(selectedPath ?? inputPath)
      const destination = cleanPath(outputPath)
      const validation = inputPathError(input)
      if (validation) {
        setNotice(validation)
        return
      }
      if (destination && (!isAbsolutePath(destination) || /[\r\n\0]/.test(destination))) {
        setNotice('O destino também precisa ser um caminho local completo.')
        return
      }
      operation.current = true
      setBusy('analyze')
      setNotice('')
      setError(null)
      analyzingController.current = new AbortController()
      try {
        const next = await api.analyze(
          {
            inputPath: input,
            ...(destination ? { outputPath: destination } : {}),
            cameraResolution,
            quality,
          },
          analyzingController.current.signal,
        )
        setAnalysis(next)
        setAnalyzedSettings({ cameraResolution, quality })
        setInputPath(next.inputPath)
        setOutputPath(next.outputPath)
        setPhase('analysis')
      } catch (failure) {
        if (!analyzingController.current.signal.aborted) {
          setError(asApiError(failure))
          setPhase('error')
        }
      } finally {
        operation.current = false
        setBusy(null)
      }
    },
    [inputPath, outputPath, cameraResolution, quality],
  )

  const pick = async (kind: 'folder' | 'zip') => {
    if (operation.current) return
    operation.current = true
    setBusy('pick')
    setNotice('')
    let selected: string | null = null
    try {
      const response = await api.pickInput(kind)
      selected = response.inputPath
      if (selected) setInputPath(selected)
    } catch {
      setNotice(
        'O seletor local não está disponível. Cole o caminho completo abaixo — nenhum arquivo será enviado.',
      )
    } finally {
      operation.current = false
      setBusy(null)
    }
    if (selected) await analyze(selected)
  }

  const start = async () => {
    if (
      operation.current ||
      !analysis ||
      analysisDirty ||
      !ready ||
      analysis.diskSpace.sufficient === false
    )
      return
    operation.current = true
    setBusy('start')
    setNotice('')
    try {
      const id = await api.createJob({
        inputPath: analysis.inputPath,
        outputPath: analysis.outputPath,
        cameraResolution,
        quality,
      })
      setJobId(id)
      setProgress(null)
      setFurthestStep(-1)
      setResult(null)
      setPhase('processing')
    } catch (failure) {
      setError(asApiError(failure))
      setPhase('error')
    } finally {
      operation.current = false
      setBusy(null)
    }
  }

  const cancel = async () => {
    if (!jobId || operation.current) return
    operation.current = true
    setBusy('cancel')
    setNotice('')
    try {
      const snapshot = await api.cancel(jobId)
      if (
        snapshot &&
        typeof snapshot === 'object' &&
        'state' in snapshot &&
        (snapshot as JobSnapshot).state === 'cancelled'
      )
        setPhase('cancelled')
      else
        setNotice(
          'Cancelamento solicitado. Aguardando o serviço encerrar o processamento com segurança.',
        )
    } catch (failure) {
      setNotice(`Não foi possível confirmar o cancelamento. ${asApiError(failure).message}`)
    } finally {
      operation.current = false
      setBusy(null)
    }
  }

  const reset = () => {
    setPhase('input')
    setAnalysis(null)
    setResult(null)
    setError(null)
    setProgress(null)
    setInputPath('')
    setOutputPath('')
    setCameraResolution(DEFAULT_EXPORT_SETTINGS.cameraResolution)
    setQuality(DEFAULT_EXPORT_SETTINGS.quality)
    setAnalyzedSettings(null)
    setNotice('')
    setJobId(null)
    setFurthestStep(-1)
  }
  const back = () => {
    setError(null)
    setNotice('')
    setPhase(analysis ? 'analysis' : 'input')
  }

  return {
    phase,
    inputPath,
    setInputPath,
    outputPath,
    setOutputPath,
    analysis,
    result,
    error,
    status,
    checkingStatus,
    busy,
    notice,
    setNotice,
    jobId,
    progress,
    furthestStep,
    connection,
    ready,
    outputDirty,
    cameraResolution,
    setCameraResolution,
    quality,
    setQuality,
    exportSettingsDirty,
    analysisDirty,
    analyze,
    pick,
    start,
    cancel,
    reset,
    back,
    reconnect: () => setStreamAttempt((attempt) => attempt + 1),
  }
}

export type Bridge = ReturnType<typeof useBridge>
