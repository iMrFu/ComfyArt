import { useState } from 'react'
import { atom, useValue, type Editor } from 'tldraw'

import { generateAudio, MUSIC_SECONDS, SFX_SECONDS, voices, type AudioSpec } from '../assetGen'
import { AUDIO, type AudioShape } from '../shapes/EmbedShapes'
import { Modal } from './Modal'
import { Chips } from './Chips'
import { t } from '../i18n'

type Tab = 'music' | 'speech' | 'sfx'
const TABS: [Tab, string][] = [['music', t('audio.music')], ['speech', t('audio.voiceover')], ['sfx', t('audio.soundEffect')]]
const CLONE = 'clone'
const VOXCPM2 = 'voxcpm2'
const VOXCPM2_CLONE = 'voxcpm2_clone'

export const audioDialogAtom = atom<boolean>('audio dialog', false)

export function AudioDialog({ editor, onError }: { editor: Editor; onError: (msg: string) => void }) {
  const open = useValue(audioDialogAtom)
  const [tab, setTab] = useState<Tab>('music')
  const [prompt, setPrompt] = useState('')
  const [lyrics, setLyrics] = useState('')
  const [seconds, setSeconds] = useState(30)
  const [picked, setVoice] = useState('')
  const [voiceDesign, setVoiceDesign] = useState('')
  const reference = useValue('selected audio', () => {
    const s = editor.getOnlySelectedShape()
    return s?.type === AUDIO ? (s as AudioShape).props.src : null
  }, [editor])
  if (!open) return null
  const list = voices()
  const voice = picked === CLONE || picked === VOXCPM2 || picked === VOXCPM2_CLONE || list.includes(picked) ? picked : list[0]
  const close = () => audioDialogAtom.set(false)
  const durations = tab === 'music' ? MUSIC_SECONDS : SFX_SECONDS
  const pick = (next: Tab) => {
    setTab(next)
    if (next !== 'speech') setSeconds(next === 'music' ? 30 : 8)
  }
  const spec = (): AudioSpec | null => {
    const text = prompt.trim()
    if (!text) return null
    if (tab === 'music') return { kind: 'music', prompt: text, lyrics: lyrics.trim(), seconds }
    if (tab === 'sfx') return { kind: 'sfx', prompt: text, seconds }
    if (voice === VOXCPM2_CLONE && reference) return { kind: 'voxcpm2_clone', text, reference }
    if (voice === VOXCPM2) return { kind: 'voxcpm2', text, voiceDesign: voiceDesign.trim() }
    return voice === CLONE && reference ? { kind: 'clone', text, reference } : { kind: 'speech', text, voice: voice === CLONE ? list[0] : voice }
  }
  const run = () => {
    const s = spec()
    if (!s) return
    close()
    generateAudio(editor, s, onError)
  }

  return (
    <Modal title={t('audio.generateAudio')} onClose={close}>
      <div className="ca-rename__body">
        <Chips value={tab} options={TABS} onPick={pick} />
        <textarea
          autoFocus
          className="ca-panel__prompt ca-panel__prompt--boxed"
          value={prompt}
          placeholder={tab === 'music' ? t('audio.musicPlaceholder') : tab === 'sfx' ? t('audio.sfxPlaceholder') : t('audio.speechPlaceholder')}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        {tab === 'music' && (
          <textarea className="ca-panel__prompt ca-panel__prompt--boxed" value={lyrics} placeholder={t('audio.lyricsPlaceholder')} onChange={(e) => setLyrics(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        )}
        {tab === 'speech' ? (
          <div className="ca-rename__field"><span>{t('audio.voice')}</span>
            <select className="ca-panel__input" value={voice} onChange={(e) => setVoice(e.target.value)}>
              {reference && <option value={CLONE}>{t('audio.cloneSelected')}</option>}
              {reference && <option value={VOXCPM2_CLONE}>{t('audio.voxcpm2Clone')}</option>}
              <option value={VOXCPM2}>{t('audio.voxcpm2')}</option>
              {list.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
        ) : (
          <div className="ca-rename__field"><span>{t('audio.duration')}</span>
            <Chips value={seconds} options={durations.map((s) => [s, `${s}s`] as const)} onPick={setSeconds} />
          </div>
        )}
        {voice === VOXCPM2 && (
          <div className="ca-rename__field"><span>{t('audio.voiceDesign')}</span>
            <input className="ca-panel__input" type="text" value={voiceDesign} placeholder={t('audio.voiceDesignPlaceholder')} onChange={(e) => setVoiceDesign(e.target.value)} />
          </div>
        )}
        <div className="ca-panel__foot">
          <button type="button" className="ca-panel__secondary" onClick={close}>{t('common.cancel')}</button>
          <button type="button" className="ca-panel__primary" disabled={!prompt.trim()} onClick={run}>{t('common.generate')}</button>
        </div>
      </div>
    </Modal>
  )
}
