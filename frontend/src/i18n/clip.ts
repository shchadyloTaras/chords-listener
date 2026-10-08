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
  },
  en: {
    'clip.title': 'YouTube fragment',
    'clip.intro': 'Pick {seconds} seconds — the cloud downloads just those and finds the chords, in time with the video.',
    'clip.window': 'Fragment · {seconds} s',
    'clip.windowLabel': 'Video fragment',
    'clip.fromHere': 'From here',
    'clip.preview': 'Preview',
    'clip.analyze': 'Find the chords',
  },
}
