import { loadWorkflow, type PromptGraph } from './comfy'

export const randomSeed = () => Math.floor(Math.random() * 2 ** 31)

export interface Built { graph: PromptGraph; result: string }

export function annotated(src: string): string {
  const q = new URL(src, location.origin).searchParams
  const sub = q.get('subfolder')
  return `${sub ? `${sub}/` : ''}${q.get('filename')} [${q.get('type') || 'input'}]`
}

const MODEL_SCALE = 4

export async function upscaleGraph(image: string, w: number, h: number, factor: number): Promise<Built> {
  const g = await loadWorkflow('upscale-ultrasharp-4x.api.json')
  g['1'].inputs.image = image
  if (factor > MODEL_SCALE) {
    g['5'] = { class_type: 'ImageScaleBy', inputs: { image: ['1', 0], upscale_method: 'lanczos', scale_by: factor / MODEL_SCALE } }
    g['3'].inputs.image = ['5', 0]
  } else if (factor < MODEL_SCALE) {
    g['5'] = { class_type: 'ImageScale', inputs: { image: ['3', 0], upscale_method: 'lanczos', width: Math.round(w * factor), height: Math.round(h * factor), crop: 'disabled' } }
    g['4'].inputs.images = ['5', 0]
  }
  return { graph: g, result: '4' }
}

const REFINE_LONG = 2048
const snap16 = (v: number) => Math.max(16, Math.round(v / 16) * 16)

export async function creativeUpscaleGraph(image: string, factor: number, w: number, h: number, style: string, strength: number): Promise<Built> {
  const g = await upscaleGraph(image, w, h, MODEL_SCALE).then((b) => b.graph)
  const t2i = await loadWorkflow('qwen-image-2.1-t2i.api.json')
  const k = Math.min(factor, REFINE_LONG / Math.max(w, h))
  const [tw, th] = [Math.round(w * factor), Math.round(h * factor)]
  for (const id of ['1', '3', '4', '6', '7', '8']) g[`r${id}`] = t2i[id]
  g.r5 = { class_type: 'ImageScale', inputs: { image: ['3', 0], upscale_method: 'lanczos', width: snap16(w * k), height: snap16(h * k), crop: 'disabled' } }
  g.r9 = { class_type: 'VAEEncode', inputs: { pixels: ['r5', 0], vae: ['r4', 0] } }
  g.r6.inputs = { ...g.r6.inputs, prompt: `Highly detailed, sharp, clean high resolution image${style ? `, ${style}` : ''}.`, clip: ['r3', 0] }
  g.r7.inputs = { ...g.r7.inputs, seed: randomSeed(), denoise: strength, model: ['r1', 0], positive: ['r6', 0], negative: ['r6', 1], latent_image: ['r9', 0] }
  g.r8.inputs = { samples: ['r7', 0], vae: ['r4', 0] }
  g['4'].inputs.images = ['r8', 0]
  if (snap16(w * k) !== tw || snap16(h * k) !== th) {
    g.r10 = { class_type: 'ImageScale', inputs: { image: ['r8', 0], upscale_method: 'lanczos', width: tw, height: th, crop: 'disabled' } }
    g['4'].inputs.images = ['r10', 0]
  }
  return { graph: g, result: '4' }
}

export async function cutoutGraph(image: string): Promise<Built> {
  const g = await loadWorkflow('cutout-birefnet.api.json')
  g['17'].inputs.image = image
  return { graph: g, result: '18' }
}

export async function eraseGraph(image: string, mask: string): Promise<Built> {
  const g = await loadWorkflow('erase-lama.api.json')
  g['1'].inputs.image = image
  g['2'].inputs.image = mask
  g['5'].inputs.seed = randomSeed()
  return { graph: g, result: '6' }
}

export async function expandGraph(image: string, pads: { l: number; t: number; r: number; b: number }, prompt: string): Promise<Built> {
  const g = await loadWorkflow('outpaint-qwen-image-2.1.api.json')
  g['11'].inputs.image = image
  for (const id of ['21', '27']) Object.assign(g[id].inputs, { left: pads.l, top: pads.t, right: pads.r, bottom: pads.b })
  g['25'].inputs.string_b = prompt
  g['7'].inputs.seed = randomSeed()
  return { graph: g, result: '9' }
}

export async function editGraph(image: string, prompt: string): Promise<Built> {
  const g = await loadWorkflow('edit-qwen-image-2.1.api.json')
  g['11'].inputs.image = image
  g['6'].inputs.prompt = prompt
  g['7'].inputs.seed = randomSeed()
  return { graph: g, result: '9' }
}

export async function moveGraph(image: string, mask: string, from: Crop, to: { x: number; y: number }): Promise<Built> {
  const g = await loadWorkflow('erase-lama.api.json')
  g['1'].inputs.image = image
  g['2'].inputs.image = mask
  g['5'].inputs.seed = randomSeed()
  g['7'] = { class_type: 'GrowMask', inputs: { mask: ['2', 0], expand: 12, tapered_corners: true } }
  g['5'].inputs.mask = ['7', 0]
  g['8'] = { class_type: 'ImageCrop', inputs: { image: ['1', 0], width: from.w, height: from.h, x: from.x, y: from.y } }
  g['9'] = { class_type: 'CropMask', inputs: { mask: ['2', 0], x: from.x, y: from.y, width: from.w, height: from.h } }
  g['10'] = { class_type: 'ImageCompositeMasked', inputs: { destination: ['5', 0], source: ['8', 0], x: Math.max(0, to.x), y: Math.max(0, to.y), resize_source: false, mask: ['9', 0] } }
  g['6'].inputs.images = ['10', 0]
  return { graph: g, result: '6' }
}

export async function styleGraph(image: string, style: string, ref: string | null): Promise<Built> {
  const g = await loadWorkflow('edit-qwen-image-2.1.api.json')
  g['11'].inputs.image = image
  if (ref) {
    g['12'] = { class_type: 'LoadImage', inputs: { image: ref } }
    g['6'].inputs['images.image_2'] = ['12', 0]
  }
  g['6'].inputs.prompt = ref
    ? 'Redraw image 1 in the visual style of image 2: palette, brushwork, texture and rendering. Keep the composition, subjects and layout of image 1.'
    : `Redraw this image in ${style} style. Keep the composition, subjects and layout unchanged.`
  g['7'].inputs.seed = randomSeed()
  return { graph: g, result: '9' }
}

export interface Crop { x: number; y: number; w: number; h: number }

export async function touchGraph(image: string, crop: Crop, mask: string, prompt: string): Promise<Built> {
  const g = await loadWorkflow('edit-qwen-image-2.1.api.json')
  g['20'] = { class_type: 'LoadImage', inputs: { image } }
  g['11'] = { class_type: 'ImageCrop', inputs: { image: ['20', 0], width: crop.w, height: crop.h, x: crop.x, y: crop.y } }
  g['21'] = { class_type: 'ImageScale', inputs: { image: ['8', 0], upscale_method: 'bicubic', width: crop.w, height: crop.h, crop: 'disabled' } }
  g['22'] = { class_type: 'LoadImageMask', inputs: { image: mask, channel: 'alpha' } }
  g['23'] = { class_type: 'ImageCompositeMasked', inputs: { destination: ['20', 0], source: ['21', 0], x: crop.x, y: crop.y, resize_source: false, mask: ['22', 0] } }
  g['6'].inputs.prompt = prompt
  g['7'].inputs.seed = randomSeed()
  g['9'].inputs.images = ['23', 0]
  return { graph: g, result: '9' }
}

const AZIMUTHS: [number, string][] = [
  [0, 'front view'], [45, 'front-right quarter view'], [90, 'right side view'], [135, 'back-right quarter view'],
  [180, 'back view'], [225, 'back-left quarter view'], [270, 'left side view'], [315, 'front-left quarter view'],
]

export function anglePrompt(horizontal: number, vertical: number, zoom: number): string {
  const az = ((horizontal % 360) + 360) % 360
  const azKw = AZIMUTHS.reduce((best, cur) => {
    const d = (a: number) => Math.min(Math.abs(az - a), 360 - Math.abs(az - a))
    return d(cur[0]) < d(best[0]) ? cur : best
  })[1]
  const elKw = vertical <= -15 ? 'low-angle shot' : vertical <= 15 ? 'eye-level shot' : vertical <= 45 ? 'elevated shot' : 'high-angle shot'
  const distKw = zoom >= 7 ? 'close-up' : zoom >= 3 ? 'medium shot' : 'wide shot'
  return `<qma> ${azKw} ${elKw} ${distKw}`
}

export async function anglesGraph(image: string, horizontal: number, vertical: number, zoom: number): Promise<Built> {
  const g = await loadWorkflow('multiangle-qwen-image-2.1.api.json')
  g['11'].inputs.image = image
  g['6'].inputs.prompt = anglePrompt(horizontal, vertical, zoom)
  g['7'].inputs.seed = randomSeed()
  return { graph: g, result: '9' }
}

export async function layersGraph(image: string, layers: number, prompt: string): Promise<Built> {
  const g = await loadWorkflow('layers-qwen-image-layered.api.json')
  g['74'].inputs.image = image
  g['82'].inputs.largest_size = 1024
  g['116'].inputs.value = prompt || 'An image with a foreground subject and a background.'
  g['83:118'].inputs.layers = layers
  g['83:3'].inputs.seed = randomSeed()
  return { graph: g, result: '60' }
}

export function samGraph(image: string, target: { text: string } | { x: number; y: number } | { points: { x: number; y: number }[] }): Built {
  const graph: PromptGraph = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sam3.1_multiplex_fp16.safetensors' } },
    '2': { class_type: 'LoadImage', inputs: { image } },
    '4': { class_type: 'SAM3_Detect', inputs: { model: ['1', 0], image: ['2', 0], threshold: 0.4, refine_iterations: 2, individual_masks: false } },
    '5': { class_type: 'MaskToImage', inputs: { mask: ['4', 0] } },
    '6': { class_type: 'PreviewImage', inputs: { images: ['5', 0] } },
  }
  if ('text' in target) {
    graph['3'] = { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: target.text } }
    graph['4'].inputs.conditioning = ['3', 0]
  } else {
    const points = 'points' in target ? target.points : [target]
    graph['4'].inputs.positive_coords = JSON.stringify(points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })))
  }
  return { graph, result: '6' }
}

export function samBoxesGraph(image: string, boxes: Crop[]): Built {
  const graph: PromptGraph = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sam3.1_multiplex_fp16.safetensors' } },
    '2': { class_type: 'LoadImage', inputs: { image } },
  }
  let batch: [string, number] | null = null
  boxes.forEach((b, i) => {
    graph[`d${i}`] = { class_type: 'SAM3_Detect', inputs: { model: ['1', 0], image: ['2', 0], threshold: 0.4, refine_iterations: 2, individual_masks: false, bboxes: { x: b.x, y: b.y, width: b.w, height: b.h } } }
    graph[`m${i}`] = { class_type: 'MaskToImage', inputs: { mask: [`d${i}`, 0] } }
    if (batch) graph[`b${i}`] = { class_type: 'ImageBatch', inputs: { image1: batch, image2: [`m${i}`, 0] } }
    batch = batch ? [`b${i}`, 0] : [`m${i}`, 0]
  })
  graph['9'] = { class_type: 'PreviewImage', inputs: { images: batch! } }
  return { graph, result: '9' }
}
