import { react, type Editor, type TLImageShape, type TLShapeId, type TLVideoShape } from 'tldraw'

import * as actions from './actions'
import { generateAudio, imageTo3d, voices } from './assetGen'
import { editElements } from './elements'
import { bakeToImage, createMockup } from './mockup'
import { api, type ImageRef } from './comfy'
import { LAYOUT_HANDLERS, shapeOf, type Args, type Handler } from './botLayout'
import { placeInChatFrame } from './chatFrame'
import { capRefs, createGenerator, generate } from './generate'
import { DURATIONS, RATIOS, VIDEO_RATIOS } from './genOptions'
import { MAX_VIDEO_REF_KINDS, VIDEO_TARGETS } from './videoGraphs'
import { type ErrorSink, errorText, fileSrc, GAP, mediaAsset, placeMedia, type Media, resultsAtom } from './jobs'
import { agentModels } from './models'
import { AUDIO } from './shapes/EmbedShapes'
import { GENERATOR, type GeneratorShape } from './shapes/GeneratorShape'
import { MOCKUP, type MockupShape } from './shapes/MockupShape'
import { vectorize } from './vectorize'
import type { Crop } from './workflows'
import { CLIENT_ID, onComfyEvent, onReconnect } from './ws'

const AUDIO_MAX_SECONDS = 1000

function mediaSrc(editor: Editor, shape: TLShape): string | null {
  return mediaAsset(editor, shape)?.props.src ?? null
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

function place(editor: Editor, id: TLShapeId, args: Args, chat: string) {
  const shape = editor.getShape(id)!
  if (args.frame) {
    const frame = shapeOf(editor, args.frame)
    if (frame.type !== 'frame') throw new Error(`${frame.id} is not a frame`)
    editor.reparentShapes([id], frame.id)
    editor.updateShape({ id, type: shape.type, x: GAP, y: GAP })
  } else if (args.near) {
    const b = editor.getShapePageBounds(shapeOf(editor, args.near))!
    editor.updateShape({ id, type: shape.type, x: b.maxX + GAP, y: b.y })
  } else if (chat) {
    placeInChatFrame(editor, id, chat)
  }
}

function toChat(editor: Editor, chat: string, holder: TLShapeId | undefined) {
  const result = started(editor, holder)
  if (chat) placeInChatFrame(editor, holder!, chat)
  return result
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

function startGenerator(editor: Editor, video: boolean, args: Args, onError: ErrorSink, chat: string) {
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
  place(editor, id, args, chat)
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

const HANDLERS: Record<string, Handler> = {
  ...LAYOUT_HANDLERS,
  list_models: () => ({
    image: agentModels(false).map((m) => ({ id: m.id, label: m.label, desc: m.desc, accepts_refs: !!m.refs, ratios: RATIOS })),
    video: agentModels(true).map((m) => ({ id: m.id, label: m.label, desc: m.desc, accepts_first_frame: true, max_reference_images: MAX_VIDEO_REF_KINDS.image, max_reference_videos: MAX_VIDEO_REF_KINDS.video, max_reference_audios: MAX_VIDEO_REF_KINDS.audio, motion_control: true, lip_sync: true, ratios: VIDEO_RATIOS, durations: DURATIONS })),
  }),
  generate_image: (editor, args, onError, chat) => startGenerator(editor, false, args, onError, chat),
  generate_video: (editor, args, onError, chat) => startGenerator(editor, true, args, onError, chat),
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
  split_layers: (editor, args, onError) => started(editor, actions.splitLayers(editor, imageOf(editor, args.id), Number(args.layers) || 4, String(args.prompt ?? ''), onError)),
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
  generate_music: (editor, args, onError, chat) => toChat(editor, chat, generateAudio(editor, { kind: 'music', prompt: String(args.prompt), lyrics: String(args.lyrics ?? ''), seconds: Math.min(AUDIO_MAX_SECONDS, Math.max(1, Number(args.duration) || 30)) }, onError, true)),
  generate_sound_effect: (editor, args, onError, chat) => toChat(editor, chat, generateAudio(editor, { kind: 'sfx', prompt: String(args.prompt), seconds: Math.min(AUDIO_MAX_SECONDS, Math.max(1, Number(args.duration) || 8)) }, onError, true)),
  text_to_speech: (editor, args, onError, chat) => {
    const text = String(args.text)
    if (args.reference) {
      const shape = shapeOf(editor, args.reference)
      if (shape.type !== AUDIO) throw new Error(`${shape.id} is not an audio shape`)
      return toChat(editor, chat, generateAudio(editor, { kind: 'clone', text, reference: fileSrc(editor, shape)! }, onError, true))
    }
    const model = String(args.model ?? '')
    if (model === 'voxcpm2') {
      return toChat(editor, chat, generateAudio(editor, { kind: 'voxcpm2', text, voiceDesign: String(args.voice_design ?? '') }, onError, true))
    }
    if (args.voice && !voices().includes(args.voice)) throw new Error(`voice must be one of ${voices().join(', ')}`)
    return toChat(editor, chat, generateAudio(editor, { kind: 'speech', text, voice: args.voice ?? voices()[0] }, onError, true))
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
}

export function registerCommandBus(editor: Editor, project: string, isStale: () => boolean, onError: ErrorSink) {
  const announce = () => api('/comfyart/mcp_page', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: CLIENT_ID, project }) }).catch((e) => onError(errorText(e)))
  void announce()
  const stops = [
    onReconnect(() => void announce()),
    onComfyEvent('comfyart-mcp-command', (msg: { id: string; action: string; project: string; chat?: string; args: Args }) => {
      if (msg.project !== project || isStale()) return
      const handler = HANDLERS[msg.action]
      const reply = (body: object) => api('/comfyart/mcp_command_result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_id: msg.id, ...body }) })
        .catch((e) => onError(errorText(e)))
      if (!handler) return void reply({ ok: false, error: `unknown command ${msg.action}` })
      editor.markHistoryStoppingPoint(`agent:${msg.action}`)
      Promise.resolve()
        .then(() => handler(editor, msg.args ?? {}, onError, msg.chat ?? ''))
        .then((result) => reply({ ok: true, result }), (e) => reply({ ok: false, error: errorText(e) }))
    }),
  ]
  return () => stops.forEach((stop) => stop())
}
