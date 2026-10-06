import type { Dict } from './index'

// Owned by the "keys" agent (live piano). Keys prefixed "keys.".
export const keys: Dict = {
  uk: {
    'keys.title': 'Живе фортепіано',
    'keys.canvas': 'Клавіатура фортепіано: клавіші натискаються й світяться, коли в пісні звучать відповідні ноти',
    'keys.canvas.harmonium':
      'Клавіші фісгармонії, 37 від «до» малої октави до «до» третьої: клавіші натискаються й світяться, коли в пісні звучать відповідні ноти',
    'keys.sounding': 'Звучить: {notes}',
    'keys.silence': 'Ноти не звучать',

    'keys.status.loading': 'Завантажую ноти…',
    'keys.status.audio': 'Отримую звук пісні…',
    'keys.status.decode': 'Готую звук…',
    'keys.status.computing': 'Розпізнаю ноти… {pct}%',
    'keys.status.computingShort': 'Розпізнаю ноти…',
    'keys.status.none': 'Нот не знайдено',
    'keys.status.unavailable': 'У демо-пісні немає звуку',
    'keys.firstRun': 'Перше розпізнавання займає трохи часу. Ноти збережуться, і наступного разу відкриються миттєво.',
    'keys.unavailable': 'У демо-пісні немає звуку, тож і нот немає. Натисни на акорд, щоб почути його й побачити на клавішах.',

    'keys.error.server': 'Не вдалося отримати звук пісні з сервера.',
    'keys.error.audio': 'Звук цієї пісні недоступний.',
    'keys.error.decode': 'Браузер не зміг прочитати звук цієї пісні.',
    'keys.error.model': 'Не вдалося завантажити модель розпізнавання нот. Перевір зʼєднання.',
    'keys.error.failed': 'Не вдалося розпізнати ноти.',
    'keys.retry': 'Спробувати ще',

    'keys.legend.instruments': 'Інструменти',
    'keys.legend.voice': 'Голос',
    'keys.legend.aria': 'Кольорові смуги — інструменти, контурні — голос',
    'keys.vocals.hint': 'Голос тут змішаний з музикою.',
    'keys.vocals.separate': 'Відокремити голос',
    'keys.vocals.separate.title':
      'Сервер відділить голос від музики за 1–3 хвилини: клавіші гратимуть лише інструменти, а мелодія голосу зʼявиться контуром.',
    'keys.vocals.running': 'Відокремлюю голос… {pct}%',
    'keys.vocals.error': 'Не вдалося відокремити голос.',

    'keys.recompute': 'Розпізнати заново',
    'keys.recompute.title': 'Розпізнати ноти заново (займе трохи часу)',
    'keys.hide': 'Сховати живе фортепіано',
    'keys.hidden': 'Живе фортепіано сховано. Повернути можна в налаштуваннях вигляду.',
    'keys.show': 'Повернути',

    'keys.sync': 'Синхронізація',
    'keys.sync.title': 'Синхронізація клавіш зі звуком',
    'keys.sync.slider': 'Зсув підсвічування клавіш, мілісекунди',
    'keys.sync.ms': '{n} мс',
    'keys.sync.earlier': 'раніше',
    'keys.sync.later': 'пізніше',
    'keys.sync.reset': 'Скинути',
    'keys.sync.hint':
      'Якщо клавіші світяться раніше, ніж ти чуєш ноту (так буває з Bluetooth-навушниками), посунь повзунок праворуч. Якщо пізніше — ліворуч.',
    'keys.sync.latency': 'Пристрій повідомляє затримку звуку ≈ {n} мс. Браузер уже її враховує.',

    'keys.settings.toggle': 'Живе фортепіано',
    'keys.settings.hint': 'Клавіші світяться разом із нотами пісні',
  },
  en: {
    'keys.title': 'Live piano',
    'keys.canvas': 'Piano keyboard: keys go down and light up as the matching notes sound in the song',
    'keys.canvas.harmonium': 'Harmonium keyboard, 37 keys from C3 to C6: keys go down and light up as the matching notes sound in the song',
    'keys.sounding': 'Sounding: {notes}',
    'keys.silence': 'No notes sounding',

    'keys.status.loading': 'Loading notes…',
    'keys.status.audio': 'Getting the song’s audio…',
    'keys.status.decode': 'Preparing the audio…',
    'keys.status.computing': 'Recognizing notes… {pct}%',
    'keys.status.computingShort': 'Recognizing notes…',
    'keys.status.none': 'No notes found',
    'keys.status.unavailable': 'The demo song has no audio',
    'keys.firstRun': 'The first recognition takes a moment. The notes are saved and open instantly next time.',
    'keys.unavailable': 'The demo song has no audio, so there are no notes. Click a chord to hear it and see it on the keys.',

    'keys.error.server': 'Couldn’t get the song’s audio from the server.',
    'keys.error.audio': 'This song’s audio isn’t available.',
    'keys.error.decode': 'The browser couldn’t read this song’s audio.',
    'keys.error.model': 'Couldn’t load the note recognition model. Check your connection.',
    'keys.error.failed': 'Couldn’t recognize the notes.',
    'keys.retry': 'Try again',

    'keys.legend.instruments': 'Instruments',
    'keys.legend.voice': 'Voice',
    'keys.legend.aria': 'Coloured bars are the instruments, outlined ones the voice',
    'keys.vocals.hint': 'The voice is mixed in with the music here.',
    'keys.vocals.separate': 'Separate the voice',
    'keys.vocals.separate.title':
      'The server separates the voice from the music in 1–3 minutes: the keys then play the instruments only, and the sung melody appears as outlines.',
    'keys.vocals.running': 'Separating the voice… {pct}%',
    'keys.vocals.error': 'Could not separate the voice.',

    'keys.recompute': 'Recognize again',
    'keys.recompute.title': 'Recognize the notes again (takes a moment)',
    'keys.hide': 'Hide the live piano',
    'keys.hidden': 'Live piano hidden. You can bring it back in the view settings.',
    'keys.show': 'Show again',

    'keys.sync': 'Sync',
    'keys.sync.title': 'Sync the keys with the sound',
    'keys.sync.slider': 'Key highlight offset, milliseconds',
    'keys.sync.ms': '{n} ms',
    'keys.sync.earlier': 'earlier',
    'keys.sync.later': 'later',
    'keys.sync.reset': 'Reset',
    'keys.sync.hint':
      'If the keys light up before you hear the note (common with Bluetooth headphones), move the slider right. If they’re late, move it left.',
    'keys.sync.latency': 'Your device reports ≈ {n} ms of audio latency. The browser already accounts for it.',

    'keys.settings.toggle': 'Live piano',
    'keys.settings.hint': 'Keys light up with the song’s notes',
  },
}
