import type { Dict } from './index'

// Owned by the "live" agent. Keys prefixed "live.".
export const live: Dict = {
  uk: {
    'live.region': 'Акорди наживо',
    'live.status.running': 'Наживо',
    'live.status.paused': 'Пауза',
    'live.status.stopped': 'Зупинено',
    'live.status.idle': 'Не слухаю',
    'live.status.ended': 'Звук більше не надходить',
    'live.elapsed': 'Минуло {time}',

    'live.listening': 'Слухаю…',
    'live.listening.hint': 'Акорди зʼявляться за секунду після початку музики',
    'live.idle.hint': 'Почни слухати, щоб бачити акорди наживо',
    'live.noChord': 'без акорду',
    'live.silence': 'тиша',
    'live.provisional': 'уточнюю…',
    'live.provisional.title': 'Акорд ще уточнюється: за мить стане остаточним',
    'live.paused.hint': 'Пауза: час і запис зупинені',
    'live.ended.hint': 'Джерело звуку закрито. Зупини прослуховування, щоб зберегти запис.',
    'live.error.analysis': 'Розпізнавання наживо зупинилося, але запис триває.',
    'live.quiet': 'Дуже тихо: зроби звук гучнішим або наблизь мікрофон',

    'live.key': 'Тональність',
    'live.key.title': 'Тональність за останні півтори хвилини: {key}',
    'live.tempo': '≈{n} BPM',
    'live.tempo.title': 'Темп за останні секунди: приблизно {n} ударів за хвилину',
    'live.level': 'Рівень звуку',

    // a microphone recording (no live chords)
    'live.rec.region': 'Запис із мікрофона',
    'live.rec.status': 'Запис',
    'live.rec.hint': 'Записую. Акорди розпізнаємо, коли зупиниш.',

    'live.history': 'Попередні акорди',
    'live.history.empty': 'Тут зʼявляться попередні акорди',
    'live.history.latest': 'До останнього',
    'live.now': 'зараз',
    'live.aria.chord': 'Акорд {chord}',
    'live.aria.noChord': 'Без акорду',

    // capture errors (CaptureError.code)
    'live.error.denied': 'Доступ заборонено. Дозволь мікрофон або показ вкладки в налаштуваннях сайту й спробуй ще раз.',
    'live.error.blocked': 'Браузер не дає доступу до мікрофона. Дозволь його в налаштуваннях сайту (значок біля адреси).',
    'live.error.no-audio': 'Звук вкладки не передано. Обери цю вкладку й увімкни «Також поділитися звуком вкладки».',
    'live.error.unsupported': 'Цей браузер так не вміє. Вкладку можна слухати в Chrome чи Edge на компʼютері, мікрофон — у будь-якому сучасному браузері.',
    'live.error.insecure': 'Слухати можна лише на захищеній сторінці (https або localhost).',
    'live.error.no-device': 'Мікрофон не знайдено. Підключи його й спробуй ще раз.',
    'live.error.failed': 'Не вдалося почати слухати. Спробуй ще раз.',
  },
  en: {
    'live.region': 'Live chords',
    'live.status.running': 'Live',
    'live.status.paused': 'Paused',
    'live.status.stopped': 'Stopped',
    'live.status.idle': 'Not listening',
    'live.status.ended': 'No more sound is coming in',
    'live.elapsed': '{time} elapsed',

    'live.listening': 'Listening…',
    'live.listening.hint': 'Chords show up a second after the music starts',
    'live.idle.hint': 'Start listening to see chords live',
    'live.noChord': 'no chord',
    'live.silence': 'silence',
    'live.provisional': 'checking…',
    'live.provisional.title': 'Still checking this chord: it becomes final in a moment',
    'live.paused.hint': 'Paused: time and recording are on hold',
    'live.ended.hint': 'The sound source was closed. Stop listening to keep the recording.',
    'live.error.analysis': 'Live recognition stopped, but recording goes on.',
    'live.quiet': 'Very quiet: turn the sound up or move the microphone closer',

    'live.key': 'Key',
    'live.key.title': 'Key over the last minute and a half: {key}',
    'live.tempo': '≈{n} BPM',
    'live.tempo.title': 'Tempo over the last seconds: about {n} beats per minute',
    'live.level': 'Sound level',

    'live.rec.region': 'Microphone recording',
    'live.rec.status': 'Recording',
    'live.rec.hint': 'Recording. The chords are found when you stop.',

    'live.history': 'Previous chords',
    'live.history.empty': 'Previous chords will show up here',
    'live.history.latest': 'Jump to latest',
    'live.now': 'now',
    'live.aria.chord': 'Chord {chord}',
    'live.aria.noChord': 'No chord',

    'live.error.denied': 'Access was denied. Allow the microphone or tab sharing in the site settings and try again.',
    'live.error.blocked': 'The browser blocks the microphone. Allow it in the site settings (the icon next to the address).',
    'live.error.no-audio': 'No tab audio was shared. Pick this tab and turn on “Also share tab audio”.',
    'live.error.unsupported': 'This browser can’t do that. Tab audio works in desktop Chrome or Edge; the microphone works in any modern browser.',
    'live.error.insecure': 'Listening only works on a secure page (https or localhost).',
    'live.error.no-device': 'No microphone found. Connect one and try again.',
    'live.error.failed': 'Couldn’t start listening. Please try again.',
  },
}
