import { createShapeId, type Editor, type TLImageShape, type TLShapeId } from 'tldraw'

import { loadWorkflow } from './comfy'
import { freeSpot } from './generate'
import { registerPlacer, selectResults, spawnHolder, startJob, type ErrorSink } from './jobs'
import { AUDIO, AUDIO_SIZE, MODEL } from './shapes/EmbedShapes'
import { GENERATOR } from './shapes/GeneratorShape'
import { annotated, type Built } from './workflows'
import { t } from './i18n'

export const VOICES = ['zf_xiaoxiao', 'zf_xiaoyi', 'zf_xiaobei', 'zf_xiaoni', 'zm_yunxi', 'zm_yunjian', 'zm_yunyang', 'zm_yunxia', 'af_heart', 'af_bella', 'af_nicole', 'am_adam', 'am_michael', 'bf_emma', 'bm_george', 'jf_alpha', 'jm_kumo']
const LANGS: Record<string, string> = { a: 'English', b: 'English (British)', j: 'Japanese', z: 'Mandarin Chinese', e: 'Spanish', f: 'French', h: 'Hindi', i: 'Italian', p: 'Brazilian Portuguese' }
export const MUSIC_SECONDS = [15, 30, 60, 120]
export const SFX_SECONDS = [3, 5, 8, 15]
const MODEL_SIZE = 480
const GAP = 40

export type AudioSpec =
  | { kind: 'music'; prompt: string; lyrics: string; seconds: number }
  | { kind: 'speech'; text: string; voice: string }
  | { kind: 'clone'; text: string; reference: string }
  | { kind: 'voxcpm2'; text: string; voiceDesign: string }
  | { kind: 'voxcpm2_clone'; text: string; reference: string }
  | { kind: 'sfx'; prompt: string; seconds: number }

const seed = () => Math.floor(Math.random() * 2 ** 31)

async function audioGraph(spec: AudioSpec): Promise<Built> {
  if (spec.kind === 'music') {
    const g = await loadWorkflow('music-ace-step.api.json')
    Object.assign(g['3'].inputs, { tags: spec.prompt, lyrics: spec.lyrics || '[instrumental]' })
    g['5'].inputs.seconds = spec.seconds
    g['6'].inputs.seed = seed()
    return { graph: g, result: '8' }
  }
  if (spec.kind === 'sfx') {
    const g = await loadWorkflow('sfx-stable-audio.api.json')
    g['3'].inputs.text = spec.prompt
    g['5'].inputs.seconds = spec.seconds
    g['6'].inputs.seed = seed()
    return { graph: g, result: '8' }
  }
  if (spec.kind === 'speech') {
    const g = await loadWorkflow('speech-kokoro.api.json')
    g['1'].inputs.speaker_name = spec.voice
    Object.assign(g['2'].inputs, { text: spec.text, lang: LANGS[spec.voice[0]] ?? 'English' })
    return { graph: g, result: '3' }
  }
  if (spec.kind === 'voxcpm2') {
    const g = await loadWorkflow('speech-voxcpm2.api.json')
    g['1'].inputs.text = spec.text
    g['1'].inputs.voice_design = spec.voiceDesign || ''
    return { graph: g, result: '2' }
  }
  if (spec.kind === 'voxcpm2_clone') {
    const g = await loadWorkflow('voice-clone-voxcpm2.api.json')
    g['1'].inputs.text = spec.text
    g['2'].inputs.audio = annotated(spec.reference)
    return { graph: g, result: '4' }
  }
  const g = await loadWorkflow('voice-clone-indextts.api.json')
  g['1'].inputs.audio = annotated(spec.reference)
  Object.assign(g['3'].inputs, { text: spec.text, seed: seed() })
  return { graph: g, result: '4' }
}

const LABELS: Record<AudioSpec['kind'], string> = { music: t('audio.music'), speech: t('audio.voiceover'), clone: t('audio.voiceover'), voxcpm2: t('audio.voxcpm2'), voxcpm2_clone: t('audio.voxcpm2Clone'), sfx: t('audio.soundEffect') }

export function generateAudio(editor: Editor, spec: AudioSpec, onError: ErrorSink, quiet = false): TLShapeId {
  const [w, h] = AUDIO_SIZE
  const [x, y] = freeSpot(editor, w, h)
  const id = createShapeId()
  editor.createShape({ id, type: GENERATOR, x, y, props: { w, h }, meta: { temp: true, quiet } })
  if (!quiet) editor.zoomToBounds({ x, y, w, h }, { inset: 200, animation: { duration: 200 } })
  const text = spec.kind === 'speech' || spec.kind === 'clone' || spec.kind === 'voxcpm2' || spec.kind === 'voxcpm2_clone' ? spec.text : spec.prompt
  void startJob(editor, id, audioGraph(spec), { name: `${LABELS[spec.kind]} · ${text.slice(0, 24)}`, kind: 'audio', placer: 'audio' }, onError)
  return id
}

async function modelGraph(image: string): Promise<Built> {
  const g = await loadWorkflow('image-to-3d-trellis2.api.json')
  g['1'].inputs.image = image
  return { graph: g, result: '30' }
}

export function imageTo3d(editor: Editor, shape: TLImageShape, onError: ErrorSink) {
  const asset = shape.props.assetId ? editor.getAsset(shape.props.assetId) : null
  if (asset?.type !== 'image' || !asset.props.src) return
  const holder = spawnHolder(editor, shape, [MODEL_SIZE, MODEL_SIZE])
  void startJob(editor, holder, modelGraph(annotated(asset.props.src)), { name: `${asset.props.name || t('common.image')} · 3D`, kind: 'model', placer: 'model' }, onError)
  return holder
}

registerPlacer('audio', async (editor, holder, media, job) => {
  const ids: TLShapeId[] = []
  editor.run(() => {
    editor.deleteShape(holder.id)
    media.forEach((m, i) => {
      const id = createShapeId()
      editor.createShape({ id, type: AUDIO, x: holder.x, y: holder.y + i * (AUDIO_SIZE[1] + GAP), parentId: holder.parentId, props: { src: m.src, name: job.name } })
      ids.push(id)
    })
  }, { history: 'ignore' })
  selectResults(editor, holder, ids)
})

registerPlacer('model', async (editor, holder, media, job) => {
  const { w, h } = holder.props as { w: number; h: number }
  const ids: TLShapeId[] = []
  editor.run(() => {
    editor.deleteShape(holder.id)
    media.forEach((m, i) => {
      const id = createShapeId()
      editor.createShape({ id, type: MODEL, x: holder.x + i * (w + GAP), y: holder.y, parentId: holder.parentId, props: { w, h, src: m.src, name: job.name, ext: 'glb' } })
      ids.push(id)
    })
  }, { history: 'ignore' })
  selectResults(editor, holder, ids)
})
