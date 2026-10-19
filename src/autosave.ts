import { atom, getSnapshot, type Editor } from 'tldraw'

import { maybeSaveVersion } from './history'
import { errorText } from './jobs'
import { coversOf, saveProject } from './projects'

export type SaveState = 'saved' | 'pending' | 'saving' | 'error'

const SAVE_DELAY = 800

export const saveStateAtom = atom<{ state: SaveState; error?: string; time?: number }>('save state', { state: 'saved' })

let flushCurrent: (() => Promise<void>) | null = null

export const saveNow = () => flushCurrent?.() ?? Promise.resolve()

export function startAutosave(editor: Editor, id: string, canSave: () => boolean, onSaved: () => void) {
  let timer = 0
  let running: Promise<void> | null = null
  const save = async () => {
    clearTimeout(timer)
    if (!canSave()) return
    while (running) await running
    saveStateAtom.set({ state: 'saving' })
    running = saveProject(id, getSnapshot(editor.store), editor.getDocumentSettings().name, coversOf(editor.store.allRecords()))
      .then(() => {
        saveStateAtom.set({ state: 'saved', time: Date.now() })
        onSaved()
        maybeSaveVersion(id, () => getSnapshot(editor.store), editor.store.query.records('shape').get().length)
      })
      .catch((e) => { saveStateAtom.set({ state: 'error', error: errorText(e) }) })
      .finally(() => { running = null })
    await running
  }
  const stop = editor.store.listen(() => {
    clearTimeout(timer)
    saveStateAtom.set({ state: 'pending' })
    timer = window.setTimeout(() => void save(), SAVE_DELAY)
  }, { scope: 'document' })
  const warn = (e: BeforeUnloadEvent) => {
    if (saveStateAtom.get().state !== 'saved' && canSave()) e.preventDefault()
  }
  window.addEventListener('beforeunload', warn)
  flushCurrent = save
  return {
    save,
    stop: () => {
      stop()
      clearTimeout(timer)
      window.removeEventListener('beforeunload', warn)
      flushCurrent = null
    },
  }
}
