import { loadNamed, type PromptGraph } from './comfy'
import { customGraph, padForOutpaint, pasteBack, resizeTo } from './customWorkflows'

export const randomSeed = () => Math.floor(Math.random() * 2 ** 31)

export interface Built { graph: PromptGraph; result: string }

export function annotated(src: string): string {
  const q = new URL(src, location.origin).searchParams
  const sub = q.get('subfolder')
  return `${sub ? `${sub}/` : ''}${q.get('filename')} [${q.get('type') || 'input'}]`
}

const MODEL_SCALE = 4

export async function upscaleGraph(image: string, w: number, h: number, factor: number): Promise<Built> {
  return (await customGraph('upscale', { image }, resizeTo(Math.round(w * factor), Math.round(h * factor)))) ?? builtinUpscale(image, w, h, factor)
}

async function builtinUpscale(image: string, w: number, h: number, factor: number): Promise<Built> {
  const { graph: g, id } = await loadNamed('upscale-ultrasharp-4x.api.json', 'image', 'upscale', 'save')
  g[id.image].inputs.image = image
  if (factor > MODEL_SCALE) {
    g['5'] = { class_type: 'ImageScaleBy', inputs: { image: [id.image, 0], upscale_method: 'lanczos', scale_by: factor / MODEL_SCALE } }
    g[id.upscale].inputs.image = ['5', 0]
  } else if (factor < MODEL_SCALE) {
    g['5'] = { class_type: 'ImageScale', inputs: { image: [id.upscale, 0], upscale_method: 'lanczos', width: Math.round(w * factor), height: Math.round(h * factor), crop: 'disabled' } }
    g[id.save].inputs.images = ['5', 0]
  }
  return { graph: g, result: id.save }
}

const REFINE_LONG = 2048
const snap16 = (v: number) => Math.max(16, Math.round(v / 16) * 16)

export async function creativeUpscaleGraph(image: string, factor: number, w: number, h: number, style: string, strength: number): Promise<Built> {
  const { graph: g, id } = await loadNamed('upscale-ultrasharp-4x.api.json', 'image', 'upscale', 'save')
  g[id.image].inputs.image = image
  const { graph: t2i, id: t } = await loadNamed('qwen-image-2.1-t2i.api.json', 'unet', 'clip', 'vae', 'prompt', 'sampler', 'decode')
  const k = Math.min(factor, REFINE_LONG / Math.max(w, h))
  const [tw, th] = [Math.round(w * factor), Math.round(h * factor)]
  Object.assign(g, { r1: t2i[t.unet], r3: t2i[t.clip], r4: t2i[t.vae], r6: t2i[t.prompt], r7: t2i[t.sampler], r8: t2i[t.decode] })
  g.r5 = { class_type: 'ImageScale', inputs: { image: [id.upscale, 0], upscale_method: 'lanczos', width: snap16(w * k), height: snap16(h * k), crop: 'disabled' } }
  g.r9 = { class_type: 'VAEEncode', inputs: { pixels: ['r5', 0], vae: ['r4', 0] } }
  g.r6.inputs = { ...g.r6.inputs, prompt: `Highly detailed, sharp, clean high resolution image${style ? `, ${style}` : ''}.`, clip: ['r3', 0] }
  g.r7.inputs = { ...g.r7.inputs, seed: randomSeed(), denoise: strength, model: ['r1', 0], positive: ['r6', 0], negative: ['r6', 1], latent_image: ['r9', 0] }
  g.r8.inputs = { samples: ['r7', 0], vae: ['r4', 0] }
  g[id.save].inputs.images = ['r8', 0]
  if (snap16(w * k) !== tw || snap16(h * k) !== th) {
    g.r10 = { class_type: 'ImageScale', inputs: { image: ['r8', 0], upscale_method: 'lanczos', width: tw, height: th, crop: 'disabled' } }
    g[id.save].inputs.images = ['r10', 0]
  }
  return { graph: g, result: id.save }
}

export async function cutoutGraph(image: string): Promise<Built> {
  const custom = await customGraph('cutout', { image })
  if (custom) return custom
  const { graph: g, id } = await loadNamed('cutout-birefnet.api.json', 'image', 'save')
  g[id.image].inputs.image = image
  return { graph: g, result: id.save }
}

export async function eraseGraph(image: string, mask: string): Promise<Built> {
  const custom = await customGraph('erase', { image, mask })
  if (custom) return custom
  const { graph: g, id } = await loadNamed('erase-lama.api.json', 'image', 'mask', 'inpaint', 'save')
  g[id.image].inputs.image = image
  g[id.mask].inputs.image = mask
  g[id.inpaint].inputs.seed = randomSeed()
  return { graph: g, result: id.save }
}

export async function expandGraph(image: string, pads: { l: number; t: number; r: number; b: number }, prompt: string): Promise<Built> {
  const custom = await customGraph('expand', { image, prompt }, padForOutpaint(image, pads))
  if (custom) return custom
  const { graph: g, id } = await loadNamed('outpaint-qwen-image-2.1.api.json', 'image', 'pad', 'blendPad', 'prompt', 'sampler', 'save')
  g[id.image].inputs.image = image
  for (const pad of [id.pad, id.blendPad]) Object.assign(g[pad].inputs, { left: pads.l, top: pads.t, right: pads.r, bottom: pads.b })
  g[id.prompt].inputs.string_b = prompt
  g[id.sampler].inputs.seed = randomSeed()
  return { graph: g, result: id.save }
}

export async function editGraph(image: string, prompt: string): Promise<Built> {
  const custom = await customGraph('edit', { image, prompt })
  if (custom) return custom
  const { graph: g, id } = await loadNamed('edit-qwen-image-2.1.api.json', 'image', 'prompt', 'sampler', 'save')
  g[id.image].inputs.image = image
  g[id.prompt].inputs.prompt = prompt
  g[id.sampler].inputs.seed = randomSeed()
  return { graph: g, result: id.save }
}

export async function moveGraph(image: string, mask: string, from: Crop, to: { x: number; y: number }): Promise<Built> {
  const { graph: g, id } = await loadNamed('erase-lama.api.json', 'image', 'mask', 'inpaint', 'save')
  g[id.image].inputs.image = image
  g[id.mask].inputs.image = mask
  g[id.inpaint].inputs.seed = randomSeed()
  g['7'] = { class_type: 'GrowMask', inputs: { mask: [id.mask, 0], expand: 12, tapered_corners: true } }
  g[id.inpaint].inputs.mask = ['7', 0]
  g['8'] = { class_type: 'ImageCrop', inputs: { image: [id.image, 0], width: from.w, height: from.h, x: from.x, y: from.y } }
  g['9'] = { class_type: 'CropMask', inputs: { mask: [id.mask, 0], x: from.x, y: from.y, width: from.w, height: from.h } }
  g['10'] = { class_type: 'ImageCompositeMasked', inputs: { destination: [id.inpaint, 0], source: ['8', 0], x: Math.max(0, to.x), y: Math.max(0, to.y), resize_source: false, mask: ['9', 0] } }
  g[id.save].inputs.images = ['10', 0]
  return { graph: g, result: id.save }
}

export async function styleGraph(image: string, style: string, ref: string | null): Promise<Built> {
  const prompt = ref
    ? 'Redraw image 1 in the visual style of image 2: palette, brushwork, texture and rendering. Keep the composition, subjects and layout of image 1.'
    : `Redraw this image in ${style} style. Keep the composition, subjects and layout unchanged.`
  const custom = await customGraph('style', { image, image2: ref ?? undefined, prompt })
  if (custom) return custom
  const { graph: g, id } = await loadNamed('edit-qwen-image-2.1.api.json', 'image', 'prompt', 'sampler', 'save')
  g[id.image].inputs.image = image
  if (ref) {
    g['12'] = { class_type: 'LoadImage', inputs: { image: ref } }
    g[id.prompt].inputs['images.image_2'] = ['12', 0]
  }
  g[id.prompt].inputs.prompt = prompt
  g[id.sampler].inputs.seed = randomSeed()
  return { graph: g, result: id.save }
}

export interface Crop { x: number; y: number; w: number; h: number }

export async function touchGraph(image: string, crop: Crop, mask: string, prompt: string): Promise<Built> {
  const custom = await customGraph('inpaint', { image, prompt }, pasteBack(image, mask, crop))
  if (custom) return custom
  const { graph: g, id } = await loadNamed('edit-qwen-image-2.1.api.json', 'image', 'prompt', 'sampler', 'decode', 'save')
  g['20'] = { class_type: 'LoadImage', inputs: { image } }
  g[id.image] = { class_type: 'ImageCrop', inputs: { image: ['20', 0], width: crop.w, height: crop.h, x: crop.x, y: crop.y } }
  g['21'] = { class_type: 'ImageScale', inputs: { image: [id.decode, 0], upscale_method: 'bicubic', width: crop.w, height: crop.h, crop: 'disabled' } }
  g['22'] = { class_type: 'LoadImageMask', inputs: { image: mask, channel: 'alpha' } }
  g['23'] = { class_type: 'ImageCompositeMasked', inputs: { destination: ['20', 0], source: ['21', 0], x: crop.x, y: crop.y, resize_source: false, mask: ['22', 0] } }
  g[id.prompt].inputs.prompt = prompt
  g[id.sampler].inputs.seed = randomSeed()
  g[id.save].inputs.images = ['23', 0]
  return { graph: g, result: id.save }
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
  const custom = await customGraph('angles', { image, prompt: anglePrompt(horizontal, vertical, zoom) })
  if (custom) return custom
  const { graph: g, id } = await loadNamed('multiangle-qwen-image-2.1.api.json', 'image', 'prompt', 'sampler', 'save')
  g[id.image].inputs.image = image
  g[id.prompt].inputs.prompt = anglePrompt(horizontal, vertical, zoom)
  g[id.sampler].inputs.seed = randomSeed()
  return { graph: g, result: id.save }
}

export async function layersGraph(image: string, layers: number, prompt: string): Promise<Built> {
  const custom = await customGraph('layers', { image, prompt: prompt || undefined, count: layers })
  if (custom) return custom
  const { graph: g, id } = await loadNamed('layers-qwen-image-layered.api.json', 'image', 'scale', 'prompt', 'latent', 'sampler', 'save')
  g[id.image].inputs.image = image
  g[id.scale].inputs.largest_size = 1024
  g[id.prompt].inputs.value = prompt || 'An image with a foreground subject and a background.'
  g[id.latent].inputs.layers = layers
  g[id.sampler].inputs.seed = randomSeed()
  return { graph: g, result: id.save }
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
