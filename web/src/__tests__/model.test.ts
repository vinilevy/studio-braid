import { describe, expect, it, vi } from 'vitest'
import {
  cleanPath,
  copyText,
  formatBytes,
  formatDuration,
  formatPreciseDuration,
  friendlyProgress,
  formatFrameRate,
  friendlyError,
  inputPathError,
  isAbsolutePath,
  parseProgress,
  progressStep,
} from '../lib/model'

const event = {
  stage: 'reconstruct',
  percent: 15,
  currentTrack: 'display',
  message: 'Reconstruindo',
}

describe('local project paths', () => {
  it.each([
    ['/Users/Levi/Gravações/Teste.screenstudio', '/Users/Levi/Gravações/Teste.screenstudio'],
    ['  "C:\\Gravações\\Projeto.screenstudio.zip"  ', 'C:\\Gravações\\Projeto.screenstudio.zip'],
    ["'/Users/Levi/Projeto.screenstudio'", '/Users/Levi/Projeto.screenstudio'],
    [
      'file:///Users/Levi/Grava%C3%A7%C3%B5es/Meu%20Projeto.screenstudio',
      '/Users/Levi/Gravações/Meu Projeto.screenstudio',
    ],
    [
      'file:///C:/Grava%C3%A7%C3%B5es/Projeto.screenstudio.zip',
      'C:\\Gravações\\Projeto.screenstudio.zip',
    ],
    ['file://localhost/Users/Levi/Projeto.screenstudio', '/Users/Levi/Projeto.screenstudio'],
    [
      'file://nas/Gravacoes/Projeto.screenstudio.zip',
      '\\\\nas\\Gravacoes\\Projeto.screenstudio.zip',
    ],
  ])('normalizes %s without uploading or discarding Unicode', (input, expected) => {
    const cleaned = cleanPath(input)
    expect(cleaned).toBe(expected)
    expect(isAbsolutePath(cleaned)).toBe(true)
    expect(inputPathError(cleaned)).toBeNull()
  })

  it.each([
    'C:\\Projeto.SCREENSTUDIO.ZIP',
    '/Volumes/Projects/Teste.screenstudio/',
    '\\\\host\\share\\Teste.screenstudio.zip',
    'D:/Teste.screenstudio',
  ])('accepts full package paths: %s', (path) => {
    expect(inputPathError(path)).toBeNull()
  })

  it.each([
    '',
    'Projeto.screenstudio',
    'C:Projeto.screenstudio',
    '/Users/Projeto.zip',
    '/Users/a.screenstudio\n/Users/b.screenstudio',
    '/Users/a\0.screenstudio',
  ])('rejects empty, relative, wrong-type or multiline paths: %s', (path) => {
    expect(inputPathError(path)).toEqual(expect.any(String))
  })

  it('does not throw for an invalid file URI', () => {
    expect(() => cleanPath('file:///Users/Bad%ZZ.screenstudio')).not.toThrow()
    expect(inputPathError(cleanPath('file:///Users/Bad%ZZ.screenstudio'))).not.toBeNull()
  })
})

describe('duration and disk labels', () => {
  it.each([
    [0, '00:00:00'],
    [999, '00:00:00'],
    [75_432, '00:01:15'],
    [3_661_000, '01:01:01'],
    [360_000_000, '100:00:00'],
    [-500, '00:00:00'],
  ])('formats %i ms as %s', (duration, expected) => {
    expect(formatDuration(duration)).toBe(expected)
  })

  it('keeps unknown disk space distinct from zero and uses localized units', () => {
    expect(formatBytes(null)).toBe('Não informado')
    expect(formatBytes(0)).toBe('0 MB')
    expect(formatBytes(1024 ** 2)).toBe('1 MB')
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1,5 GB')
  })
})

describe('SSE progress parsing and channel ordering', () => {
  it('preserves optional result/state while clamping only the percentage', () => {
    expect(
      parseProgress(JSON.stringify({ ...event, percent: 200, state: 'running', jobId: 'job-123' })),
    ).toEqual({ ...event, percent: 100, state: 'running', jobId: 'job-123' })
    expect(parseProgress(JSON.stringify({ ...event, percent: -15 }))?.percent).toBe(0)
  })

  it.each([
    'invalid json',
    'null',
    '[]',
    '1',
    '"text"',
    '{}',
    JSON.stringify({ ...event, percent: '15' }),
    JSON.stringify({ ...event, currentTrack: null }),
    JSON.stringify({ ...event, message: null }),
    JSON.stringify({ ...event, stage: null }),
    '{"stage":"x","percent":1e999,"currentTrack":"display","message":"x"}',
  ])('ignores malformed progress: %s', (raw) => {
    expect(parseProgress(raw)).toBeNull()
  })

  it.each([
    ['display', 0],
    ['webcam', 1],
    ['microphone', 2],
    ['systemAudio', 3],
    ['fcpxml', 4],
    ['unknown', -1],
  ])('maps track %s to step %i', (currentTrack, expected) => {
    expect(progressStep({ ...event, currentTrack })).toBe(expected)
  })

  it('maps explicit terminal and FCPXML stages ahead of the track', () => {
    expect(progressStep(null)).toBe(-1)
    expect(progressStep({ ...event, stage: 'fcpxml' })).toBe(4)
    expect(progressStep({ ...event, stage: 'complete' })).toBe(5)
    expect(progressStep({ ...event, state: 'completed' })).toBe(5)
  })
})

describe('friendly errors and clipboard', () => {
  it.each([
    ['CONNECTION_ERROR', /serviço local/i],
    ['HTTP_503', /serviço local/i],
    ['ENOSPC', /espaço/i],
    ['DISK_FULL', /espaço/i],
    ['FFPROBE_MISSING', /FFprobe/i],
    ['INVALID_PATH', /caminho/i],
    ['OUTPUT_NOT_EMPTY', /vazia/i],
    ['SYNC_FAILED', /sincronismo/i],
  ])('explains %s without blindly displaying engine diagnostics', (code, wording) => {
    const text = friendlyError({ code, message: 'opaque technical diagnostic' })
    expect(text).toMatch(wording)
    expect(text).not.toContain('opaque technical diagnostic')
  })

  it('gives a safe fallback for an unknown error', () => {
    expect(friendlyError({ code: 'NEW_ERROR_CODE', message: 'secret engine detail' })).toMatch(
      /origem não foram alterados/i,
    )
  })

  it('writes exactly the requested local report text to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as unknown as Clipboard)
    await copyText('local report')
    expect(writeText).toHaveBeenCalledWith('local report')
  })

  it('fails with manual-copy guidance when clipboard access is unavailable', async () => {
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue(undefined as unknown as Clipboard)
    await expect(copyText('path')).rejects.toThrow(/manualmente/i)
  })
})

describe('human-readable ffprobe frame rates', () => {
  it.each([
    ['30000/1001', '29,97'],
    ['25/1', '25'],
    ['24', '24'],
    ['0/0', null],
    ['1/0', null],
    ['-1/1', null],
    ['abc', null],
    [undefined, null],
  ])('formats %s without misleading invalid metrics', (value, expected) => {
    expect(formatFrameRate(value)).toBe(expected)
  })
})

describe('millisecond duration precision in final results', () => {
  it.each([
    [0, '00:00:00.000'],
    [15_235, '00:00:15.235'],
    [2_098_202.016, '00:34:58.202'],
    [59_999.6, '00:01:00.000'],
    [3_599_999.6, '01:00:00.000'],
    [-20, '00:00:00.000'],
  ])('formats %s ms without dropping milliseconds or breaking carry', (ms, expected) => {
    expect(formatPreciseDuration(ms)).toBe(expected)
  })
})

describe('plain-language progress captions', () => {
  it.each([
    'queued',
    'analyze',
    'reconstruct',
    'concat',
    'validate',
    'fcpxml',
    'cancelling',
    'cancelled',
    'failed',
    'complete',
    'future-stage',
  ])('does not expose engine jargon in stage %s', (stage) => {
    const caption = friendlyProgress({
      stage,
      percent: 42,
      currentTrack: 'display',
      message: 'FFprobe: duration, codec, decoded frames.',
    })
    expect(caption).not.toMatch(/FFprobe|codec|decoded/i)
    expect(caption.length).toBeGreaterThan(10)
  })
  it('uses a clear starting caption before any event', () => {
    expect(friendlyProgress(null)).toBe('Iniciando a preparação do projeto…')
  })
})
