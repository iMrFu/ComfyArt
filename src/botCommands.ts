import { createShapeId, react, type Editor, type TLFrameShape, type TLImageShape, type TLShape, type TLShapeId, type TLVideoShape } from 'tldraw'

import * as actions from './actions'
import { generateAudio, imageTo3d, VOICES } from './assetGen'
import { editElements } from './elements'
import { bakeToImage, createMockup } from './mockup'
import { api, type ImageRef } from './comfy'
import { placeHtml } from './embeds'
import { capRefs, createGenerator, DURATIONS, generate, genInfoOf, RATIOS, VIDEO_RATIOS } from './generate'
import { MAX_VIDEO_REF_KINDS } from './workflows'
import { type ErrorSink, errorText, fileSrc, jobOf, mediaAsset, placeMedia, type Media, resultsAtom } from './jobs'
import { describeItem, itemImages, libraryAtom, linkedKit } from './library'
import { correct, forget, memoryAtom, remember } from './memory'
import { agentModels } from './models'
import { buildSlides } from './slides'
import { exportImage } from './shapes/ArtboardShape'
import { COMMENT } from './shapes/CommentShape'
import { AUDIO, HTML, type HtmlShape } from './shapes/EmbedShapes'
import { GENERATOR, type GeneratorShape } from './shapes/GeneratorShape'
import { MOCKUP, type MockupShape } from './shapes/MockupShape'
import { TEXT, type TextShape } from './shapes/TextShape'
import { VECTOR, type VectorShape } from './shapes/VectorShape'
import { loadSkills, saveSkill } from './skills'
import { vectorize } from './vectorize'
import { VIDEO_TARGETS, type Crop } from './workflows'
import { onComfyEvent } from './ws'
import { t } from './i18n'
import { uuid } from './id'

type Args = Record<string, any>
type Handler = (editor: Editor, args: Args, onError: ErrorSink) => unknown

const MAX_SHAPES = 300
const VIEW_MAX_PX = 1024
const GAP = 40

function mediaSrc(editor: Editor, shape: TLShape): string | null {
  return mediaAsset(editor, shape)?.props.src ?? null
}

function shapeOf(editor: Editor, id: unknown): TLShape {
  const shape = typeof id === 'string' ? editor.getShape(id as TLShapeId) : undefined
  if (!shape) throw new Error(`no shape ${JSON.stringify(id)} — use ids from get_canvas`)
  return shape
}

function imageOf(editor: Editor, id: unknown): TLImageShape {
  const shape = shapeOf(editor, id)
  if (shape.type !== 'image') throw new Error(`${shape.id} is a ${shape.type}, not an image`)
  return shape as TLImageShape
}

function videoOf(editor: Editor, id: unknown): TLVideoShape {
  const shape = shapeOf(editor, id)
  if (shape.type !== 'video') throw new Error(`${shape.id} is a ${shape.type}, not a video`)
  return shape as TLVideoShape
}

function regionOf(args: Args): Crop {
  const r = { x: Number(args.x) || 0, y: Number(args.y) || 0, w: Number(args.width), h: Number(args.height) }
  if (!(r.w > 0 && r.h > 0)) throw new Error('width and height must be positive image pixels')
  return r
}

function nameOf(editor: Editor, shape: TLShape): string {
  if (shape.type === 'frame') return (shape as TLFrameShape).props.name
  if (shape.type === TEXT) return (shape as TextShape).props.text.slice(0, 200)
  return mediaAsset(editor, shape)?.props.name || (shape.props as { name?: string }).name || ''
}

function describe(editor: Editor, shape: TLShape) {
  const b = editor.getShapePageBounds(shape)!
  const parent = editor.getShape(shape.parentId as TLShapeId)
  const gen = genInfoOf(shape)
  const job = jobOf(shape)
  const media = mediaAsset(editor, shape)
  return {
    id: shape.id,
    type: shape.type === GENERATOR ? (job ? 'generating' : 'generator') : shape.type,
    name: nameOf(editor, shape) || undefined,
    x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.w), height: Math.round(b.h),
    ...(parent?.type === 'frame' ? { frame: parent.id } : {}),
    ...(media?.props.src ? { url: media.props.src, pixels: `${media.props.w}x${media.props.h}` } : fileSrc(editor, shape) ? { url: fileSrc(editor, shape) } : {}),
    ...(gen?.prompt ? { prompt: gen.prompt.slice(0, 300) } : {}),
    ...(shape.type === GENERATOR ? { prompt: (shape as GeneratorShape).props.prompt.slice(0, 300) } : {}),
  }
}

function pageOf(editor: Editor, page: unknown) {
  if (!page) return editor.getCurrentPage()
  const found = editor.getPages().find((p) => p.id === page || p.name === page)
  if (!found) throw new Error(`no page ${JSON.stringify(page)}`)
  return found
}

function toPageShapes(editor: Editor, ids: TLShapeId[]) {
  return ids.map((id) => editor.getShape(id)!).filter(Boolean)
}

async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function place(editor: Editor, id: TLShapeId, args: Args) {
  const shape = editor.getShape(id)!
  if (args.frame) {
    const frame = shapeOf(editor, args.frame)
    if (frame.type !== 'frame') throw new Error(`${frame.id} is not a frame`)
    editor.reparentShapes([id], frame.id)
    editor.updateShape({ id, type: shape.type, x: GAP, y: GAP })
  } else if (args.near) {
    const b = editor.getShapePageBounds(shapeOf(editor, args.near))!
    editor.updateShape({ id, type: shape.type, x: b.maxX + GAP, y: b.y })
  }
}

function refUrls(editor: Editor, refs: unknown): string[] {
  if (!Array.isArray(refs)) return []
  return refs.map((r) => {
    if (typeof r === 'string' && /^(\/|https?:)/.test(r)) return r
    const src = fileSrc(editor, shapeOf(editor, r))
    if (!src) throw new Error(`${r} has no image`)
    return src
  })
}

function startGenerator(editor: Editor, video: boolean, args: Args, onError: ErrorSink) {
  const models = agentModels(video)
  const wantsRefs = !video && Array.isArray(args.refs) && args.refs.length > 0
  const model = args.model ? models.find((m) => m.id === args.model) : (wantsRefs && models.find((m) => m.refs)) || models[0]
  if (!model) throw new Error(`unknown model ${JSON.stringify(args.model)} — see list_models`)
  if (wantsRefs && !model.refs) throw new Error(`${model.label} does not accept refs; use a model with accepts_refs from list_models, or drop refs`)
  const ratios = video ? VIDEO_RATIOS : RATIOS
  if (args.ratio && !ratios.includes(args.ratio)) throw new Error(`ratio must be one of ${ratios.join(', ')}`)
  const props = video
    ? { prompt: String(args.prompt), workflow: model.id, ratio: args.ratio ?? ratios[0], duration: DURATIONS.includes(args.duration) ? args.duration : DURATIONS[0] }
    : { prompt: String(args.prompt), workflow: model.id, ratio: args.ratio ?? '1:1', count: Math.min(4, Math.max(1, Number(args.count) || 1)) }
  const media = video ? [...refUrls(editor, args.reference_images), ...refUrls(editor, args.reference_videos), ...refUrls(editor, args.reference_audios)] : []
  const motion = video && args.motion_video ? refUrls(editor, [args.motion_video])[0] : null
  const speech = video && args.speech_audio ? refUrls(editor, [args.speech_audio])[0] : null
  if ((motion || speech) && !args.first_frame) throw new Error(`${motion ? 'motion_video' : 'speech_audio'} needs first_frame: the image of the person`)
  const mode = motion ? 'motion' : speech ? 'lipsync' : media.length ? 'refs' : null
  const refs = !video ? refUrls(editor, args.refs) : mode === 'refs' ? capRefs(media) : refUrls(editor, args.first_frame ? [args.first_frame] : [])
  const meta = {
    quiet: true,
    ...(mode ? { videoMode: mode } : {}),
    ...(motion ? { motion } : {}),
    ...(speech ? { speech } : {}),
    ...(refs.length ? { refs } : {}),
    ...(!video && args.base ? { base: refUrls(editor, [args.base])[0], strength: Number(args.base_strength) || 60 } : {}),
    ...(video && !mode && args.last_frame ? { lastFrame: refUrls(editor, [args.last_frame])[0] } : {}),
  }
  const id = createGenerator(editor, video, props, false)
  editor.updateShape<GeneratorShape>({ id, type: GENERATOR, meta })
  place(editor, id, args)
  void generate(editor, editor.getShape<GeneratorShape>(id)!, onError)
  return { ids: [id], model: model.id, note: 'call wait_generation with these ids' }
}

function started(editor: Editor, holder: TLShapeId | undefined) {
  if (!holder) throw new Error('that shape has no source media to work on')
  const shape = editor.getShape(holder)!
  editor.updateShape({ id: holder, type: shape.type, meta: { ...shape.meta, quiet: true } })
  return { ids: [holder], note: 'call wait_generation with these ids' }
}

function shapesWithSrc(editor: Editor, srcs: string[]): string[] {
  const all = editor.store.query.records('shape').get()
  return srcs.flatMap((src) => all.filter((s) => fileSrc(editor, s) === src).map((s) => s.id))
}

function waitResults(editor: Editor, ids: string[], timeout: number) {
  const unknown = new Set(ids.filter((id) => !resultsAtom.get()[id] && !editor.getShape(id as TLShapeId)))
  const settle = () => {
    const results = resultsAtom.get()
    return ids.map((id) => {
      const r = results[id]
      if (!r) return { id, status: unknown.has(id) ? 'unknown id' : 'running' }
      return r.error ? { id, status: 'error', error: r.error } : { id, status: 'done', urls: r.srcs, shapes: shapesWithSrc(editor, r.srcs) }
    })
  }
  return new Promise<object>((resolve) => {
    let stop = () => { }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      stop()
      const results = settle()
      resolve({ status: results.some((r) => r.status === 'running') ? 'running' : 'done', results })
    }
    const timer = setTimeout(finish, timeout * 1000)
    stop = react('wait generation', () => {
      if (settle().every((r) => r.status !== 'running')) queueMicrotask(finish)
    })
  })
}

function textProps(args: Args): Partial<TextShape['props']> {
  return {
    text: String(args.text ?? ''),
    ...(args.font_size ? { size: Number(args.font_size) } : {}),
    ...(args.color ? { color: String(args.color) } : {}),
    ...(args.font ? { font: String(args.font) } : {}),
    ...(args.align ? { align: String(args.align) } : {}),
    ...(args.width ? { w: Number(args.width), autoSize: false } : {}),
  }
}

const HANDLERS: Record<string, Handler> = {
  get_canvas: (editor, args) => {
    const page = pageOf(editor, args.page)
    const ids = [...editor.getPageShapeIds(page.id)]
    const shapes = toPageShapes(editor, ids).filter((s) => s.type !== COMMENT).slice(0, MAX_SHAPES).map((s) => describe(editor, s))
    const kit = linkedKit(editor.getDocumentSettings().meta.brandKit)
    return {
      project: editor.getDocumentSettings().name || undefined,
      pages: editor.getPages().map((p) => ({ id: p.id, name: p.name, current: p.id === editor.getCurrentPageId() })),
      page: page.id,
      shapes,
      truncated: ids.length > MAX_SHAPES || undefined,
      selection: editor.getSelectedShapeIds(),
      brand_kit: kit ? { id: kit.id, name: kit.name } : null,
    }
  },
  view_canvas: async (editor, args) => {
    const ids = Array.isArray(args.ids) && args.ids.length ? args.ids.map((id: string) => shapeOf(editor, id).id) : [...editor.getCurrentPageShapeIds()]
    if (!ids.length) throw new Error('the page is empty')
    const shapes = toPageShapes(editor, ids)
    const bounds = shapes.map((s) => editor.getShapePageBounds(s)!).reduce((a, b) => a.union(b))
    const maxPx = Math.min(2048, Number(args.max_px) || VIEW_MAX_PX)
    const { blob, width, height } = await exportImage(editor, ids, { format: 'png', background: true, scale: Math.min(1, maxPx / Math.max(bounds.w, bounds.h)) })
    return { width, height, bounds: { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.w), height: Math.round(bounds.h) }, png: await blobBase64(blob) }
  },
  list_models: () => ({
    image: agentModels(false).map((m) => ({ id: m.id, label: m.label, desc: m.desc, accepts_refs: !!m.refs, ratios: RATIOS })),
    video: agentModels(true).map((m) => ({ id: m.id, label: m.label, desc: m.desc, accepts_first_frame: true, max_reference_images: MAX_VIDEO_REF_KINDS.image, max_reference_videos: MAX_VIDEO_REF_KINDS.video, max_reference_audios: MAX_VIDEO_REF_KINDS.audio, motion_control: true, lip_sync: true, ratios: VIDEO_RATIOS, durations: DURATIONS })),
  }),
  brand_kits: (editor) => {
    const linked = linkedKit(editor.getDocumentSettings().meta.brandKit)
    return {
      linked: linked?.id ?? null,
      items: libraryAtom.get().map((k) => ({ id: k.id, kind: k.kind, name: k.name, summary: describeItem(k), images: itemImages(k) })),
    }
  },
  generate_image: (editor, args, onError) => startGenerator(editor, false, args, onError),
  generate_video: (editor, args, onError) => startGenerator(editor, true, args, onError),
  edit_image: (editor, args, onError) => started(editor, actions.quickEdit(editor, imageOf(editor, args.id), String(args.prompt), onError)),
  animate_image: (editor, args, onError) => started(editor, actions.animate(editor, imageOf(editor, args.id), String(args.prompt), onError, args.loop !== false)),
  upscale_image: (editor, args, onError) => {
    const factor = args.factor === 4 ? 4 : 2
    const shape = imageOf(editor, args.id)
    return started(editor, args.creative ? actions.creativeUpscale(editor, shape, factor, String(args.style ?? ''), 0.3, onError) : actions.upscale(editor, shape, factor, onError))
  },
  remove_background: (editor, args, onError) => started(editor, actions.cutout(editor, imageOf(editor, args.id), onError)),
  expand_image: (editor, args, onError) => started(editor, actions.expand(editor, imageOf(editor, args.id),
    { l: Number(args.left) || 0, t: Number(args.top) || 0, r: Number(args.right) || 0, b: Number(args.bottom) || 0 }, String(args.prompt ?? ''), onError)),
  split_layers: (editor, args, onError) => started(editor, actions.splitLayers(editor, imageOf(editor, args.id), Math.min(8, Math.max(2, Number(args.layers) || 4)), String(args.prompt ?? ''), onError)),
  change_angle: (editor, args, onError) => started(editor, actions.angles(editor, imageOf(editor, args.id), Number(args.horizontal) || 0, Number(args.vertical) || 0, Number(args.zoom) || 1, onError)),
  replace_text: (editor, args, onError) => started(editor, actions.editText(editor, imageOf(editor, args.id), [[String(args.from), String(args.to)]], onError)),
  edit_region: (editor, args, onError) => started(editor, actions.editRegion(editor, imageOf(editor, args.id), regionOf(args), String(args.prompt), onError)),
  erase_region: (editor, args, onError) => started(editor, actions.eraseRegion(editor, imageOf(editor, args.id), regionOf(args), onError)),
  move_object: (editor, args, onError) => {
    if (!args.object && (args.x == null || args.y == null)) throw new Error('give object (what to move) or x/y (a point on it, image pixels)')
    const target = args.object ? { text: String(args.object) } : { x: Number(args.x), y: Number(args.y) }
    return started(editor, actions.moveTarget(editor, imageOf(editor, args.id), target, Number(args.dx) || 0, Number(args.dy) || 0, onError))
  },
  style_transfer: (editor, args, onError) => started(editor, actions.styleTransfer(editor, imageOf(editor, args.id), String(args.style ?? ''), args.ref ? refUrls(editor, [args.ref])[0] : null, onError)),
  vectorize_image: async (editor, args) => ({ id: await vectorize(editor, imageOf(editor, args.id)) }),
  extend_video: (editor, args, onError) => started(editor, actions.extendVideo(editor, videoOf(editor, args.id), String(args.prompt), DURATIONS.includes(args.duration) ? args.duration : DURATIONS[0], onError)),
  upscale_video: (editor, args, onError) => {
    const long = (VIDEO_TARGETS.find(([label]) => label === args.target) ?? VIDEO_TARGETS[0])[1]
    return started(editor, actions.upscaleVideo(editor, videoOf(editor, args.id), long, onError))
  },
  remove_video_background: (editor, args, onError) => started(editor, actions.cutoutVideo(editor, videoOf(editor, args.id), onError)),
  generate_music: (editor, args, onError) => started(editor, generateAudio(editor, { kind: 'music', prompt: String(args.prompt), lyrics: String(args.lyrics ?? ''), seconds: Math.min(240, Math.max(5, Number(args.duration) || 30)) }, onError, true)),
  generate_sound_effect: (editor, args, onError) => started(editor, generateAudio(editor, { kind: 'sfx', prompt: String(args.prompt), seconds: Math.min(47, Math.max(1, Number(args.duration) || 8)) }, onError, true)),
  text_to_speech: (editor, args, onError) => {
    const text = String(args.text)
    const model = String(args.model ?? 'voxcpm2')
    if (args.reference && model !== 'kokoro') {
      const shape = shapeOf(editor, args.reference)
      if (shape.type !== AUDIO) throw new Error(`${shape.id} is not an audio shape`)
      return started(editor, generateAudio(editor, { kind: 'voxcpm2_clone', text, reference: fileSrc(editor, shape)! }, onError, true))
    }
    if (model === 'voxcpm2') {
      return started(editor, generateAudio(editor, { kind: 'voxcpm2', text, voiceDesign: String(args.voice_design ?? '') }, onError, true))
    }
    if (args.voice && !VOICES.includes(args.voice)) throw new Error(`voice must be one of ${VOICES.join(', ')}`)
    return started(editor, generateAudio(editor, { kind: 'speech', text, voice: args.voice ?? VOICES[0] }, onError, true))
  },
  edit_elements: (editor, args, onError) => started(editor, editElements(editor, imageOf(editor, args.id), onError)),
  create_mockup: (editor, args, onError) => started(editor, createMockup(editor, imageOf(editor, args.id), onError)),
  place_design: async (editor, args) => {
    const shape = shapeOf(editor, args.id)
    if (shape.type !== MOCKUP) throw new Error(`${shape.id} is not a mockup — make one with create_mockup`)
    const p = (shape as MockupShape).props
    const num = (v: unknown, fallback: number) => (v == null ? fallback : Number(v))
    editor.updateShape<MockupShape>({
      id: shape.id as MockupShape['id'], type: MOCKUP,
      props: {
        ...(args.design ? { design: refUrls(editor, [args.design])[0] } : {}),
        x: num(args.x, p.x), y: num(args.y, p.y), scale: num(args.scale, p.scale),
        rotation: (num(args.rotation, (p.rotation * 180) / Math.PI) * Math.PI) / 180, warp: num(args.warp, p.warp),
      },
    })
    return args.bake ? { image: await bakeToImage(editor, editor.getShape<MockupShape>(shape.id as MockupShape['id'])!) } : { updated: shape.id }
  },
  image_to_3d: (editor, args, onError) => started(editor, imageTo3d(editor, imageOf(editor, args.id), onError)),
  wait_generation: (editor, args) => waitResults(editor, (args.ids ?? []).map(String), Number(args.timeout_s) || 60),
  concat_videos: async (editor, args, onError) => {
    const raw = Array.isArray(args.clips) ? args.clips : (Array.isArray(args.sources) ? args.sources : [])
    if (raw.length < 2) throw new Error('concat_videos needs at least 2 clips in clips (or sources)')
    const clips = raw.map((c: any) => {
      if (typeof c === 'string') {
        const src = mediaSrc(editor, shapeOf(editor, c))
        if (!src) throw new Error(`${c} has no media`)
        return { url: src }
      }
      if (c && typeof c === 'object') {
        const id = c.source ?? c.url
        const src = mediaSrc(editor, shapeOf(editor, id))
        if (!src) throw new Error(`${id} has no media`)
        return { url: src, ...(c.in != null ? { in: Number(c.in) } : {}), ...(c.out != null ? { out: Number(c.out) } : {}) }
      }
      throw new Error('each clip must be a shape id string or {source|url, in?, out?}')
    })
    const audio = args.audio === 'first' || args.audio === 'concat' ? args.audio : 'none'
    let out: any
    try {
      const res = await api('/comfyart/concat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clips, audio }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.error || `concat failed: ${res.status}`)
      }
      out = await res.json()
    } catch (e) {
      onError(errorText(e))
      throw e
    }
    const ref: ImageRef = { filename: out.filename, subfolder: out.subfolder, type: out.type }
    const media: Media = { ref, src: out.url, w: out.width, h: out.height, kind: 'video' }
    const lastRaw = raw[raw.length - 1]
    const lastId = typeof lastRaw === 'string' ? lastRaw : (lastRaw.source ?? lastRaw.url)
    const last = editor.getShapePageBounds(shapeOf(editor, lastId))!
    const id = placeMedia(editor, media, out.filename || 'concat.mp4', last.maxX + GAP, last.y, last.w)
    return {
      id,
      url: out.url,
      duration: out.duration,
      width: out.width,
      height: out.height,
      segments: out.num_segments,
      clip_ranges: out.segments,
      audio: out.audio,
      ...(out.note ? { note: out.note } : {}),
    }
  },
  mix_audio_video: async (editor, args, onError) => {
    const videoId = args.video
    const audioId = args.audio
    if (!videoId || !audioId) throw new Error('mix_audio_video needs video and audio shape ids')
    const vSrc = mediaSrc(editor, shapeOf(editor, videoId))
    const aSrc = mediaSrc(editor, shapeOf(editor, audioId))
    if (!vSrc) throw new Error(`${videoId} has no media`)
    if (!aSrc) throw new Error(`${audioId} has no media`)

    let clips = args.audio_clips
    if (clips != null && !Array.isArray(clips)) clips = [clips]
    if (Array.isArray(clips)) {
      clips = clips.map((c: any) => {
        const o: any = {}
        if (c.in != null) o.in = Number(c.in)
        if (c.out != null) o.out = Number(c.out)
        if (c.at != null) o.at = Number(c.at)
        return o
      })
    }

    const payload: any = {
      video: vSrc,
      audio: aSrc,
      mode: args.mode === 'mix' ? 'mix' : 'replace',
    }
    if (clips) payload.audio_clips = clips
    if (args.volume != null) payload.volume = Number(args.volume)
    if (args.bg_volume != null) payload.bg_volume = Number(args.bg_volume)
    if (args.video_in != null) payload.video_in = Number(args.video_in)
    if (args.video_out != null) payload.video_out = Number(args.video_out)

    let out: any
    try {
      const res = await api('/comfyart/mix_audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.error || `mix_audio failed: ${res.status}`)
      }
      out = await res.json()
    } catch (e) {
      onError(errorText(e))
      throw e
    }
    const ref: ImageRef = { filename: out.filename, subfolder: out.subfolder, type: out.type }
    const media: Media = { ref, src: out.url, w: out.width, h: out.height, kind: 'video' }
    const v = editor.getShapePageBounds(shapeOf(editor, videoId))!
    const id = placeMedia(editor, media, out.filename || 'mix.mp4', v.maxX + GAP, v.y, v.w)
    return {
      id,
      url: out.url,
      duration: out.duration,
      width: out.width,
      height: out.height,
      mode: out.mode,
      segments: out.num_segments,
      clip_ranges: out.segments,
      ...(out.note ? { note: out.note } : {}),
    }
  },
  place_html: (editor, args) => {
    const id = placeHtml(editor, String(args.html), String(args.name ?? t('botCommands.webPage')))
    editor.updateShape<HtmlShape>({
      id, type: HTML,
      ...(args.x != null ? { x: Number(args.x) } : {}),
      ...(args.y != null ? { y: Number(args.y) } : {}),
      props: { ...(args.width ? { w: Number(args.width) } : {}), ...(args.height ? { h: Number(args.height) } : {}) },
    })
    return { id }
  },
  create_slides: (editor, args, onError) => {
    if (!Array.isArray(args.slides) || !args.slides.length) throw new Error('slides must be a non-empty array')
    const before = new Set(editor.getCurrentPageShapeIds())
    const ids = buildSlides(editor, String(args.title ?? t('botCommands.presentation')), args.slides.map((s: Args) => ({
      title: String(s.title ?? ''), bullets: Array.isArray(s.bullets) ? s.bullets.map(String) : [], image: s.image ? String(s.image) : undefined,
    })), onError)
    const frames = [...editor.getCurrentPageShapeIds()].filter((id) => !before.has(id) && editor.getShape(id)?.type === 'frame')
    return { frames, ids, note: ids.length ? 'images are generating: call wait_generation with ids' : undefined }
  },
  add_text: (editor, args) => {
    const id = createShapeId()
    const center = editor.getViewportPageBounds().center
    editor.createShape<TextShape>({ id, type: TEXT, x: Number(args.x ?? center.x), y: Number(args.y ?? center.y), props: textProps(args) })
    if (args.frame) {
      const frame = shapeOf(editor, args.frame)
      editor.reparentShapes([id], frame.id)
      editor.updateShape({ id, type: TEXT, x: Number(args.x ?? GAP), y: Number(args.y ?? GAP) })
    }
    return { id }
  },
  add_shape: (editor, args) => {
    const kinds = ['rect', 'ellipse', 'polygon', 'star']
    if (!kinds.includes(args.kind)) throw new Error(`kind must be one of ${kinds.join(', ')}`)
    const id = createShapeId()
    const center = editor.getViewportPageBounds().center
    editor.createShape<VectorShape>({
      id, type: VECTOR, x: Number(args.x ?? center.x), y: Number(args.y ?? center.y),
      props: { kind: args.kind, w: Number(args.width) || 200, h: Number(args.height) || 200, ...(args.fill ? { fill: String(args.fill) } : {}), stroke: args.stroke ? String(args.stroke) : '', ...(args.sides ? { sides: Number(args.sides) } : {}) },
    })
    if (args.frame) {
      editor.reparentShapes([id], shapeOf(editor, args.frame).id)
      editor.updateShape({ id, type: VECTOR, x: Number(args.x ?? GAP), y: Number(args.y ?? GAP) })
    }
    return { id }
  },
  create_frame: (editor, args) => {
    const id = createShapeId()
    const w = Number(args.width) || 1080
    const h = Number(args.height) || 1080
    const center = editor.getViewportPageBounds().center
    editor.createShape<TLFrameShape>({ id, type: 'frame', x: Number(args.x ?? center.x - w / 2), y: Number(args.y ?? center.y - h / 2), props: { w, h, name: String(args.name ?? t('common.artboard')) } })
    if (Array.isArray(args.children) && args.children.length) editor.reparentShapes(args.children.map((c: string) => shapeOf(editor, c).id), id)
    return { id }
  },
  update_shapes: (editor, args) => {
    if (!Array.isArray(args.updates)) throw new Error('updates must be an array')
    const updated: string[] = []
    editor.run(() => {
      for (const u of args.updates as Args[]) {
        const shape = shapeOf(editor, u.id)
        if (u.frame !== undefined) editor.reparentShapes([shape.id], u.frame ? shapeOf(editor, u.frame).id : editor.getCurrentPageId())
        const current = editor.getShape(shape.id)!
        const point = u.x != null || u.y != null
          ? editor.getPointInParentSpace(shape.id, { x: Number(u.x ?? editor.getShapePageBounds(current)!.x), y: Number(u.y ?? editor.getShapePageBounds(current)!.y) })
          : null
        const props: Record<string, unknown> = {}
        if (u.width != null && 'w' in current.props) props.w = Number(u.width)
        if (u.height != null && 'h' in current.props) props.h = Number(u.height)
        if (u.name != null && current.type === 'frame') props.name = String(u.name)
        if (u.text != null && current.type === TEXT) Object.assign(props, { text: String(u.text), rich: null })
        if (u.color != null && current.type === TEXT) props.color = String(u.color)
        if (u.color != null && current.type === VECTOR) props.fill = String(u.color)
        editor.updateShape({
          id: shape.id, type: current.type,
          ...(point ? { x: point.x, y: point.y } : {}),
          ...(u.rotation != null ? { rotation: (Number(u.rotation) * Math.PI) / 180 } : {}),
          ...(u.opacity != null ? { opacity: Number(u.opacity) } : {}),
          ...(Object.keys(props).length ? { props } : {}),
        })
        updated.push(shape.id)
      }
    })
    return { updated }
  },
  delete_shapes: (editor, args) => {
    const ids = (args.ids ?? []).map((id: string) => shapeOf(editor, id).id)
    editor.deleteShapes(ids)
    return { deleted: ids }
  },
  focus: (editor, args) => {
    const shapes = (args.ids ?? []).map((id: string) => shapeOf(editor, id))
    const page = shapes[0] && editor.getAncestorPageId(shapes[0])
    if (page) editor.setCurrentPage(page)
    editor.select(...shapes.map((s: TLShape) => s.id))
    editor.zoomToSelection({ animation: { duration: 200 } })
    return { selected: shapes.map((s: TLShape) => s.id) }
  },
  memory: async (_editor, args) => {
    if (args.action === 'list') return { memories: memoryAtom.get().map((m) => ({ text: m.text, category: m.category ?? 'about' })) }
    if (args.action === 'add') {
      await remember([{ text: String(args.text), category: args.category }], t('botCommands.chat'))
      return { added: args.text }
    }
    if (args.action === 'correct') return { corrected: await correct([{ old: String(args.old), new: String(args.new) }], t('botCommands.chat')) }
    if (args.action === 'forget') return { forgotten: await forget([String(args.text)], t('botCommands.chat')) }
    throw new Error('action must be list, add, correct or forget')
  },
  skill: async (_editor, args) => {
    const skills = await loadSkills()
    if (args.action === 'list') return { skills: skills.map((s) => ({ name: s.name, description: s.instructions.slice(0, 200), custom: !!s.custom })) }
    if (args.action === 'save') {
      if (!args.name || !args.instructions) throw new Error('save needs name and instructions')
      const existing = skills.find((s) => s.custom && s.name === args.name)
      await saveSkill({ ...existing, id: existing?.id ?? uuid().slice(0, 8), name: String(args.name), instructions: String(args.instructions), custom: true })
      return { saved: args.name }
    }
    if (args.action !== 'read') throw new Error('action must be list, read or save')
    const skill = skills.find((s) => s.name === args.name)
    if (!skill) throw new Error(`unknown skill ${JSON.stringify(args.name)} — available: ${skills.map((s) => s.name).join(', ')}`)
    if (args.path) {
      const content = skill.files?.[args.path]
      if (content == null) throw new Error(`skill ${skill.name} has no file ${args.path}; files: ${Object.keys(skill.files ?? {}).join(', ') || '(none)'}`)
      return { name: skill.name, path: args.path, content }
    }
    return { name: skill.name, instructions: skill.instructions, files: Object.keys(skill.files ?? {}), images: Object.values(skill.images ?? {}) }
  },
}

export function registerCommandBus(editor: Editor, project: string, isStale: () => boolean, onError: ErrorSink) {
  return onComfyEvent('comfyart-mcp-command', (msg: { id: string; action: string; project: string; args: Args }) => {
    if ((msg.project && msg.project !== project) || isStale()) return
    const handler = HANDLERS[msg.action]
    const reply = (body: object) => api('/comfyart/mcp_command_result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_id: msg.id, ...body }) })
    if (!handler) return void reply({ ok: false, error: `unknown command ${msg.action}` })
    Promise.resolve()
      .then(() => handler(editor, msg.args ?? {}, onError))
      .then((result) => reply({ ok: true, result }), (e) => reply({ ok: false, error: errorText(e) }))
  })
}

