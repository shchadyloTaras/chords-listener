import type { Dict } from './index'

// The YouTube fragment picker (#/youtube/<videoId>): pick 30 seconds, the cloud downloads just those and finds the
// chords. Keys prefixed "clip.". Ukrainian first (default, informal "ти").
export const clip: Dict = {
  uk: {
    'clip.title': 'Фрагмент з YouTube',
    'clip.intro': 'Вибери {seconds} секунд — хмара завантажить лише їх і розбере акорди, точно в такт відео.',
    'clip.window': 'Фрагмент · {seconds} с',
    'clip.windowLabel': 'Фрагмент відео',
    'clip.fromHere': 'Звідси',
    'clip.preview': 'Прослухати',
    'clip.analyze': 'Розібрати акорди',
    'clip.needLength': 'Увімкни відео на мить — так ми дізнаємось його довжину й зможемо рухати рамку.',
    'clip.embedBlocked':
      'Власник не дозволяє показувати це відео на інших сайтах. Фрагмент усе одно можна розібрати — він почнеться з {time}.',
    'clip.embedFailed': 'Не вдалося завантажити відео. Фрагмент усе одно можна розібрати — він почнеться з {time}.',
  },
  en: {
    'clip.title': 'YouTube fragment',
    'clip.intro': 'Pick {seconds} seconds — the cloud downloads just those and finds the chords, in time with the video.',
    'clip.window': 'Fragment · {seconds} s',
    'clip.windowLabel': 'Video fragment',
    'clip.fromHere': 'From here',
    'clip.preview': 'Preview',
    'clip.analyze': 'Find the chords',
    'clip.needLength': 'Play the video for a moment so we learn its length and you can move the frame.',
    'clip.embedBlocked':
      "The owner doesn't allow this video on other sites. You can still analyze a fragment — it starts at {time}.",
    'clip.embedFailed': "The video didn't load. You can still analyze a fragment — it starts at {time}.",
  },
}
