// The one-time note on a browser-only song (BrowserAnalysisNote): once dismissed it stays hidden. A small
// localStorage flag; where storage is blocked the note simply shows again next time.

export const NOTE_KEY = 'chords-listener-note-browser'

export function noteDismissed(): boolean {
  try {
    return localStorage.getItem(NOTE_KEY) === '1'
  } catch {
    return false
  }
}

export function dismissNote(): void {
  try {
    localStorage.setItem(NOTE_KEY, '1')
  } catch {
    /* storage blocked: the note comes back next time */
  }
}
