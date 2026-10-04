import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserAnalysis, BrowserProgress } from '../engine'
import type { Job } from '../../types'

const engine = vi.hoisted(() => ({
  analyze: vi.fn<(file: Blob, onProgress?: BrowserProgress) => Promise<BrowserAnalysis>>(),
}))
vi.mock('../engine', () => ({ analyzeInBrowser: engine.analyze }))

import {
  contentId,
  createMemoryRepo,
  deleteLocalTrack,
  displayName,
  getLocalJob,
  getLocalTrack,
  isLocalId,
  isLocalJobId,
  listLocalTracks,
  LocalError,
  MAX_LOCAL_BYTES,
  patchLocalTrack,
  resetLocalTrack,
  setLocalRepo,
  startLocalReanalysis,
  startLocalUpload,
} from '.'

function analysis(labels: string[] = ['C', 'Am'], duration = 8): BrowserAnalysis {
  const step = duration / labels.length
  return {
    duration,
    tempo: 120,
    timeSignature: 4,
    beats: [0, 0.5, 1, 1.5],
    downbeats: [0, 2],
    chords: labels.map((label, i) => ({
      start: i * step,
      end: (i + 1) * step,
      label,
      root: label === 'N' ? null : label[0],
      quality: label.endsWith('m') ? 'min' : 'maj',
      bass: null,
      confidence: 0.9,
    })),
    key: { tonic: 'C', mode: 'major', name: 'C', confidence: 0.8 },
    waveform: [0.1, 0.5, 0.3],
    engine: 'test 1',
  }
}

function file(name: string, content = name): File {
  return new File([content], name, { type: 'audio/wav' })
}

async function settle(id: string): Promise<Job> {
  for (let i = 0; i < 200; i++) {
    const job = getLocalJob(id)
    if (job && (job.status === 'done' || job.status === 'error')) return job
    await new Promise((r) => setTimeout(r, 1))
  }
  throw new Error(`job ${id} did not finish`)
}

beforeEach(() => {
  setLocalRepo(createMemoryRepo())
  engine.analyze.mockReset()
  engine.analyze.mockImplementation(async (_blob, onProgress) => {
    onProgress?.(0.02, 'Decoding audio')
    onProgress?.(0.5, 'Detecting chords')
    onProgress?.(1, 'Done')
    return analysis()
  })
})

afterEach(() => setLocalRepo(null))

describe('helpers', () => {
  it('derives stable content ids', async () => {
    const a = await contentId(file('a.wav', 'same bytes'))
    expect(a).toMatch(/^local-[0-9a-f]{12}$/)
    expect(await contentId(file('b.mp3', 'same bytes'))).toBe(a)
    expect(await contentId(file('a.wav', 'other bytes'))).not.toBe(a)
    expect(isLocalId(a)).toBe(true)
    expect(isLocalId('0123456789ab')).toBe(false)
  })

  it('turns file names into titles like the server', () => {
    expect(displayName('my_song-take_2.wav')).toBe('my song-take 2')
    expect(displayName('Запис 2026-10-04 15-02.webm')).toBe('Запис 2026-10-04 15-02')
    expect(displayName('notes.txt')).toBe('notes.txt')
    expect(displayName('.mp3')).toBe('Untitled')
  })
})

describe('local jobs + library', () => {
  it('analyzes a file into a stored track with the server-shaped job lifecycle', async () => {
    const progress: number[] = []
    const job = await startLocalUpload(file('First_Song.wav'), (f) => progress.push(f))
    expect(isLocalJobId(job.id)).toBe(true)
    expect(job).toMatchObject({ status: 'queued', title: 'First Song', source: { type: 'file', filename: 'First_Song.wav' } })
    expect(progress.at(-1)).toBe(1)

    const done = await settle(job.id)
    expect(done.status).toBe('done')
    expect(done.progress).toBe(1)
    expect(isLocalId(done.trackId ?? '')).toBe(true)

    const [summary] = await listLocalTracks()
    expect(summary).toMatchObject({ id: done.trackId, title: 'First Song', chordCount: 2, edited: false, thumbnail: null })
    const track = await getLocalTrack(done.trackId as string)
    expect(track.chords.map((c) => c.label)).toEqual(['C', 'Am'])
    expect(track.audioUrl).toMatch(/^blob:/)
    expect(track.waveform).toEqual([0.1, 0.5, 0.3])
    // reopening keeps the same object URL (the player is not recreated by edits)
    expect((await getLocalTrack(done.trackId as string)).audioUrl).toBe(track.audioUrl)
  })

  it('reports decoding before analyzing and keeps progress monotonic', async () => {
    const seen: Array<[string, number]> = []
    let release: () => void = () => undefined
    engine.analyze.mockImplementation(async (_blob, onProgress) => {
      onProgress?.(0.01, 'Decoding audio')
      await new Promise<void>((r) => (release = r))
      onProgress?.(0.4, 'Detecting chords')
      onProgress?.(0.3, 'Detecting chords')
      return analysis()
    })
    const job = await startLocalUpload(file('stages.wav'))
    for (let i = 0; i < 50 && getLocalJob(job.id)?.status !== 'decoding'; i++) await new Promise((r) => setTimeout(r, 1))
    const decoding = getLocalJob(job.id) as Job
    seen.push([decoding.status, decoding.progress])
    release()
    const done = await settle(job.id)
    seen.push([done.status, done.progress])
    expect(seen[0][0]).toBe('decoding')
    expect(seen[0][1]).toBeGreaterThanOrEqual(0.35)
    expect(seen[0][1]).toBeLessThan(0.45)
    expect(seen[1]).toEqual(['done', 1])
  })

  it('recognizes the same file again (dedup) without analyzing twice', async () => {
    const first = await settle((await startLocalUpload(file('song.wav', 'abc'))).id)
    const again = await startLocalUpload(file('renamed.wav', 'abc'))
    expect(again).toMatchObject({ status: 'done', trackId: first.trackId, progress: 1 })
    expect(engine.analyze).toHaveBeenCalledTimes(1)
  })

  it('rejects files that are too large, and maps engine failures to error codes', async () => {
    const big = file('big.wav')
    Object.defineProperty(big, 'size', { value: MAX_LOCAL_BYTES + 1 })
    await expect(startLocalUpload(big)).rejects.toMatchObject({ code: 'too_large', status: 413 })
    await expect(startLocalUpload(file('empty.wav', ''))).rejects.toBeInstanceOf(LocalError)

    engine.analyze.mockRejectedValueOnce(new DOMException('Unable to decode audio data', 'EncodingError'))
    const bad = await settle((await startLocalUpload(file('bad.wav', 'xx'))).id)
    expect(bad).toMatchObject({ status: 'error', errorCode: 'unsupported_format' })

    engine.analyze.mockRejectedValueOnce(Object.assign(new Error('the audio is longer than 30 minutes'), { code: 'too_long' }))
    const long = await settle((await startLocalUpload(file('long.wav', 'll'))).id)
    expect(long).toMatchObject({ status: 'error', errorCode: 'too_long' })

    engine.analyze.mockResolvedValueOnce({ ...analysis(), chords: [] })
    const empty = await settle((await startLocalUpload(file('silence.wav', 'yy'))).id)
    expect(empty).toMatchObject({ status: 'error', errorCode: 'analysis_failed' })
    expect(await listLocalTracks()).toEqual([])
  })

  it('edits, resets, re-analyzes and deletes like the server API', async () => {
    const { trackId } = await settle((await startLocalUpload(file('edit.wav', 'e'))).id)
    const id = trackId as string
    const chords = [{ start: 0, end: 8, label: 'G', root: 'G', quality: 'maj', bass: null, confidence: 1 }]

    const renamed = await patchLocalTrack(id, { title: '  New title ', artist: ' Band ' })
    expect(renamed).toMatchObject({ title: 'New title', artist: 'Band', edited: false })
    expect((await patchLocalTrack(id, { title: '   ' })).title).toBe('New title')
    expect((await patchLocalTrack(id, { artist: '' })).artist).toBeNull()

    const edited = await patchLocalTrack(id, { chords })
    expect(edited).toMatchObject({ edited: true, chordCount: 1 })
    expect(edited.chords.map((c) => c.label)).toEqual(['G'])

    const reset = await resetLocalTrack(id)
    expect(reset.edited).toBe(false)
    expect(reset.chords.map((c) => c.label)).toEqual(['C', 'Am'])

    await patchLocalTrack(id, { chords })
    engine.analyze.mockResolvedValueOnce(analysis(['F', 'G', 'C']))
    const re = await settle((await startLocalReanalysis(id)).id)
    expect(re).toMatchObject({ status: 'done', trackId: id })
    const after = await getLocalTrack(id)
    expect(after).toMatchObject({ edited: false, title: 'New title' })
    expect(after.chords.map((c) => c.label)).toEqual(['F', 'G', 'C'])

    await deleteLocalTrack(id)
    await expect(getLocalTrack(id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(deleteLocalTrack(id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(startLocalReanalysis(id)).rejects.toMatchObject({ code: 'not_found' })
  })
})
