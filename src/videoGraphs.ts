import { loadWorkflow, type PromptGraph, type RefKind } from './comfy'
import { randomSeed, type Built } from './workflows'

export const VIDEO_TARGETS: [string, number][] = [['1080p', 1920], ['2K', 2560], ['4K', 3840]]
const even = (v: number) => Math.round(v / 2) * 2

export function cutoutVideoGraph(video: string): Built {
  const graph: PromptGraph = {
    v1: { class_type: 'LoadVideo', inputs: { file: video } },
    v2: { class_type: 'GetVideoComponents', inputs: { video: ['v1', 0] } },
    v3: { class_type: 'LoadBackgroundRemovalModel', inputs: { bg_removal_name: 'birefnet.safetensors' } },
    v4: { class_type: 'RemoveBackground', inputs: { bg_removal_model: ['v3', 0], image: ['v2', 0] } },
    v5: { class_type: 'MaskToImage', inputs: { mask: ['v4', 0] } },
    v6: { class_type: 'ImageBlend', inputs: { image1: ['v2', 0], image2: ['v5', 0], blend_factor: 1, blend_mode: 'multiply' } },
    v7: { class_type: 'CreateVideo', inputs: { images: ['v6', 0], audio: ['v2', 1], fps: ['v2', 2] } },
    v8: { class_type: 'SaveVideo', inputs: { video: ['v7', 0], filename_prefix: 'comfyart/video', format: 'auto', codec: 'auto' } },
  }
  return { graph, result: 'v8' }
}

export async function upscaleVideoGraph(video: string, w: number, h: number, long: number): Promise<Built> {
  const k = long / Math.max(w, h)
  const graph: PromptGraph = {
    v1: { class_type: 'LoadVideo', inputs: { file: video } },
    v2: { class_type: 'GetVideoComponents', inputs: { video: ['v1', 0] } },
    v3: { class_type: 'ImageScaleBy', inputs: { image: ['v2', 0], upscale_method: 'area', scale_by: k / 4 } },
    v4: { class_type: 'UpscaleModelLoader', inputs: { model_name: '4x-UltraSharp.pth' } },
    v5: { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['v4', 0], image: ['v3', 0] } },
    v6: { class_type: 'ImageScale', inputs: { image: ['v5', 0], upscale_method: 'lanczos', width: even(w * k), height: even(h * k), crop: 'disabled' } },
    v7: { class_type: 'CreateVideo', inputs: { images: ['v6', 0], audio: ['v2', 1], fps: ['v2', 2] } },
    v8: { class_type: 'SaveVideo', inputs: { video: ['v7', 0], filename_prefix: 'comfyart/video', format: 'auto', codec: 'auto' } },
  }
  return { graph, result: 'v8' }
}

const snap32 = (v: number) => Math.max(32, Math.round(v / 32) * 32)
export const VIDEO_AREAS: Record<string, number> = { '768p': 1344 * 768, '1080p': 1920 * 1088 }
const H3_AREA = VIDEO_AREAS['768p']

export function videoSize(aspect: number, area = H3_AREA): [number, number] {
  return [snap32(Math.sqrt(area * aspect)), snap32(Math.sqrt(area / aspect))]
}

const MOTION = 'Subtle seamless motion. Keep the composition, text and layout unchanged.'

export async function t2vGraph(prompt: string, aspect: number, duration: number, area = H3_AREA): Promise<Built> {
  const g = await loadWorkflow('t2v-minimax-h3.api.json')
  const [w, h] = videoSize(aspect, area)
  Object.assign(g['131'].inputs, { prompt, width: w, height: h })
  g['133'].inputs.value = duration
  g['129'].inputs.noise_seed = randomSeed()
  return { graph: g, result: '92' }
}

async function i2vGraph(prompt: string, aspect: number, duration: number, area = H3_AREA): Promise<PromptGraph> {
  const g = await loadWorkflow('i2v-minimax-h3.api.json')
  const [w, h] = videoSize(aspect, area)
  Object.assign(g['105:104'].inputs, { prompt, width: w, height: h })
  g['105:111'].inputs.value = duration
  g['105:15'].inputs.noise_seed = randomSeed()
  return g
}

export async function imageToVideoGraph(image: string | null, prompt: string, aspect: number, duration: number, last: string | null, area: number): Promise<Built> {
  const g = await i2vGraph(prompt || MOTION, aspect, duration, area)
  if (image) g['114'].inputs.image = image
  else {
    delete g['114']
    delete g['105:104'].inputs.first_frame
  }
  if (last) {
    g.last = { class_type: 'LoadImage', inputs: { image: last } }
    g['105:104'].inputs.last_frame = ['last', 0]
  }
  return { graph: g, result: '92' }
}

export interface MediaRef { file: string; kind: RefKind }

export const MAX_VIDEO_REF_KINDS: Record<RefKind, number> = { image: 9, video: 3, audio: 3 }
const H3_TAGS: Record<RefKind, string> = { image: 'Picture', video: 'Video', audio: 'Audio' }

function refLead(refs: MediaRef[]): string {
  const tags = (kind: RefKind) => refs.filter((r) => r.kind === kind).map((_, i) => `<${H3_TAGS[kind]} ${i + 1}>`)
  const images = tags('image')
  const others = [...tags('video'), ...tags('audio')]
  return [
    images.length && `Use ${images.join(', ')} as the reference${images.length > 1 ? 's' : ''} and keep ${images.length > 1 ? 'them' : 'it'} exactly as shown.`,
    others.length && `Use ${others.join(', ')} as reference${others.length > 1 ? 's' : ''}.`,
  ].filter(Boolean).join(' ')
}

export async function r2vGraph(refs: MediaRef[], prompt: string, aspect: number, duration: number, area: number): Promise<Built> {
  const g = await loadWorkflow('r2v-minimax-h3.api.json')
  const [w, h] = videoSize(aspect, area)
  Object.assign(g['136'].inputs, { prompt: [refLead(refs), prompt].filter(Boolean).join('\n'), width: w, height: h })
  delete g['137']
  const count: Record<RefKind, number> = { image: 0, video: 0, audio: 0 }
  refs.forEach(({ file, kind }, i) => {
    const n = count[kind]++
    if (kind === 'image') {
      g[`r${i}`] = { class_type: 'LoadImage', inputs: { image: file } }
      g['136'].inputs[`ref_images.ref_image_${n}`] = [`r${i}`, 0]
    } else if (kind === 'video') {
      g[`r${i}`] = { class_type: 'LoadVideo', inputs: { file } }
      g[`c${i}`] = { class_type: 'GetVideoComponents', inputs: { video: [`r${i}`, 0] } }
      g['136'].inputs[`ref_videos.ref_video_${n}`] = [`c${i}`, 0]
      g['136'].inputs[`ref_video_audios.ref_video_audio_${n}`] = [`c${i}`, 1]
    } else {
      g[`r${i}`] = { class_type: 'LoadAudio', inputs: { audio: file } }
      g['136'].inputs[`ref_audios.ref_audio_${n}`] = [`r${i}`, 0]
    }
  })
  g['132'].inputs.value = duration
  g['129'].inputs.noise_seed = randomSeed()
  return { graph: g, result: '92' }
}

export async function motionGraph(image: string, video: string, prompt: string, aspect: number, duration: number, area: number): Promise<Built> {
  const built = await r2vGraph([{ file: image, kind: 'image' }], `${prompt ? `${prompt}\n` : ''}The character from <Picture 1> performs exactly the body motion of the control pose video.`, aspect, duration, area)
  Object.assign(built.graph, {
    m1: { class_type: 'LoadVideo', inputs: { file: video } },
    m2: { class_type: 'Video Slice', inputs: { video: ['m1', 0], start_time: 0, duration, strict_duration: false } },
    m3: { class_type: 'GetVideoComponents', inputs: { video: ['m2', 0] } },
    m4: { class_type: 'ResizeImageMaskNode', inputs: { input: ['m3', 0], resize_type: 'scale longer dimension', 'resize_type.longer_size': 1024, scale_method: 'lanczos' } },
    m5: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdpose_wholebody_fp16.safetensors' } },
    m6: { class_type: 'UNETLoader', inputs: { unet_name: 'rt_detr_v4-x-hgnet_fp16.safetensors', weight_dtype: 'default' } },
    m7: { class_type: 'RTDETR_detect', inputs: { model: ['m6', 0], image: ['m4', 0], threshold: 0.5, class_name: 'person', max_detections: 2 } },
    m8: { class_type: 'SDPoseKeypointExtractor', inputs: { model: ['m5', 0], vae: ['m5', 2], image: ['m4', 0], batch_size: 16, bboxes: ['m7', 0] } },
    m9: { class_type: 'SDPoseDrawKeypoints', inputs: { keypoints: ['m8', 0], draw_body: true, draw_hands: true, draw_face: true, draw_feet: true, stick_width: 4, face_point_size: 2, score_threshold: 0.5, draw_head: true } },
    m10: { class_type: 'ModelPatchLoader', inputs: { name: 'minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors' } },
    m11: { class_type: 'MiniMaxH3FunControlNetApply', inputs: { model: ['127', 0], model_patch: ['m10', 0], vae: ['119', 0], strength: 1, start_percent: 0, end_percent: 1, control_video: ['m9', 0] } },
  })
  built.graph['124'].inputs.model = ['m11', 0]
  built.graph['126'].inputs.model = ['m11', 0]
  return built
}

export async function lipSyncGraph(image: string, audio: string, prompt: string, aspect: number, seconds: number, area: number): Promise<Built> {
  const g = await i2vGraph(`${prompt || 'The person talks naturally to the camera.'} The lips move in sync with the speech.`, aspect, seconds, area)
  g['114'].inputs.image = image
  g.s1 = { class_type: 'LoadAudio', inputs: { audio } }
  g.s2 = { class_type: 'MiniMaxH3AddGuide', inputs: { positive: ['105:104', 0], latent: ['105:104', 1], vae: ['105:11', 0], audio_vae: ['105:24', 0], audio: ['s1', 0], frame_idx: 0 } }
  g['105:16'].inputs.conditioning = ['s2', 0]
  return { graph: g, result: '92' }
}

const MOTION_LONG = 768
const MOTION_SECONDS = 3

export async function animateGraph(image: string, width: number, height: number, prompt: string, loop: boolean): Promise<Built> {
  const g = await i2vGraph(prompt || MOTION, width / height, MOTION_SECONDS)
  g['114'].inputs.image = image
  if (loop) g['105:104'].inputs.last_frame = ['114', 0]
  delete g['92']
  delete g['105:91']
  const k = Math.min(1, MOTION_LONG / Math.max(width, height))
  g.a1 = { class_type: 'ImageScale', inputs: { image: ['105:10', 0], upscale_method: 'lanczos', width: Math.round(width * k), height: Math.round(height * k), crop: 'disabled' } }
  g.a2 = { class_type: 'SaveAnimatedWEBP', inputs: { images: ['a1', 0], filename_prefix: 'comfyart/motion', fps: 24, lossless: false, quality: 85, method: 'default' } }
  return { graph: g, result: 'a2' }
}

export async function extendGraph(video: string, width: number, height: number, prompt: string, duration: number): Promise<Built> {
  const g = await i2vGraph(prompt || 'Continue the shot naturally.', width / height, duration)
  delete g['114']
  Object.assign(g, {
    v1: { class_type: 'LoadVideo', inputs: { file: video } },
    v2: { class_type: 'GetVideoComponents', inputs: { video: ['v1', 0] } },
    v3: { class_type: 'ImageFromBatch', inputs: { image: ['v2', 0], batch_index: -1, length: 1 } },
    v4: { class_type: 'ImageFromBatch', inputs: { image: ['105:10', 0], batch_index: 1, length: 4096 } },
    v5: { class_type: 'ImageBatch', inputs: { image1: ['v2', 0], image2: ['v4', 0] } },
    v6: { class_type: 'AudioConcat', inputs: { audio1: ['v10', 0], audio2: ['105:23', 0], direction: 'after' } },
    v7: { class_type: 'GetImageSize', inputs: { image: ['v2', 0] } },
    v8: { class_type: 'ComfyMathExpression', inputs: { expression: 'a / b', 'values.a': ['v7', 2], 'values.b': ['v2', 2] } },
    v9: { class_type: 'EmptyAudio', inputs: { duration: ['v8', 0], sample_rate: 44100, channels: 2 } },
    v10: { class_type: 'AudioMerge', inputs: { audio1: ['v9', 0], audio2: ['v2', 1], merge_method: 'add' } },
  })
  g['105:104'].inputs.first_frame = ['v3', 0]
  Object.assign(g['105:91'].inputs, { images: ['v5', 0], audio: ['v6', 0], fps: ['v2', 2] })
  return { graph: g, result: '92' }
}

export interface Scene { prompt: string; duration: number }

const SCENE_NODES = ['105:104', '105:107', '105:111', '105:15', '105:16', '105:14', '105:10', '105:23']

export async function storyboardGraph(scenes: Scene[], aspect: number, firstFrame: string | null): Promise<Built> {
  const t = await loadWorkflow('i2v-minimax-h3.api.json')
  const [w, h] = videoSize(aspect)
  const g: PromptGraph = {}
  for (const [id, node] of Object.entries(t)) if (!SCENE_NODES.includes(id) && id !== '114') g[id] = node
  if (firstFrame) g['114'] = { class_type: 'LoadImage', inputs: { image: firstFrame } }
  const local = (i: number, id: string) => `s${i}:${id}`
  scenes.forEach((scene, i) => {
    for (const id of SCENE_NODES) {
      const inputs = Object.fromEntries(Object.entries(t[id].inputs).map(([k, v]) => [k, Array.isArray(v) && SCENE_NODES.includes(String(v[0])) ? [local(i, String(v[0])), v[1]] : v]))
      g[local(i, id)] = { class_type: t[id].class_type, inputs }
    }
    const node = g[local(i, '105:104')].inputs
    Object.assign(node, { prompt: scene.prompt, width: w, height: h })
    delete node.first_frame
    if (i > 0) {
      g[`last${i}`] = { class_type: 'ImageFromBatch', inputs: { image: [local(i - 1, '105:10'), 0], batch_index: -1, length: 1 } }
      node.first_frame = [`last${i}`, 0]
    } else if (firstFrame) node.first_frame = ['114', 0]
    g[local(i, '105:111')].inputs.value = scene.duration
    g[local(i, '105:15')].inputs.noise_seed = randomSeed()
  })
  let frames: [string, number] = [local(0, '105:10'), 0]
  let audio: [string, number] = [local(0, '105:23'), 0]
  for (let i = 1; i < scenes.length; i++) {
    g[`trim${i}`] = { class_type: 'ImageFromBatch', inputs: { image: [local(i, '105:10'), 0], batch_index: 1, length: 4096 } }
    g[`join${i}`] = { class_type: 'ImageBatch', inputs: { image1: frames, image2: [`trim${i}`, 0] } }
    g[`audio${i}`] = { class_type: 'AudioConcat', inputs: { audio1: audio, audio2: [local(i, '105:23'), 0], direction: 'after' } }
    frames = [`join${i}`, 0]
    audio = [`audio${i}`, 0]
  }
  Object.assign(g['105:91'].inputs, { images: frames, audio })
  return { graph: g, result: '92' }
}
