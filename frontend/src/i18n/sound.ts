import type { Dict } from './index'

// Owned by the "sound" agent. Keys prefixed "sound.".
export const sound: Dict = {
  uk: {
    'sound.play': 'Прослухати',
    'sound.playChord': 'Прослухати {chord}',
    'sound.playNext': 'Прослухати наступний акорд {chord}',
    'sound.legend.play': 'Натисни, щоб прослухати {chord}',
    'sound.legend.copy': 'Копіювати {chord}',
    'sound.diagram.fret': 'Натисни, щоб прослухати',
    'sound.diagram.piano': 'Натисни на клавішу, щоб почути ноту, або поруч — щоб почути акорд',
    'sound.diagram.handpan': 'Натисни на поле, щоб почути ноту, або поруч — щоб почути акорд',
    'sound.settings.click': 'Звук акорду при натисканні',
    'sound.settings.clickHint': 'Кнопка «Прослухати», аплікатури й клавіша P звучать завжди',
    'sound.settings.volume': 'Гучність звуку акорду',
    'sound.settings.test': 'Прослухати акорд',
    'sound.shortcut': 'Прослухати акорд',
    'sound.handpan.none': 'На хендпані немає жодної ноти {chord}',
    'sound.unavailable': 'Цей браузер не відтворює звук акордів',
  },
  en: {
    'sound.play': 'Listen',
    'sound.playChord': 'Play {chord}',
    'sound.playNext': 'Play the next chord, {chord}',
    'sound.legend.play': 'Click to hear {chord}',
    'sound.legend.copy': 'Copy {chord}',
    'sound.diagram.fret': 'Click to hear it',
    'sound.diagram.piano': 'Click a key to hear that note, anywhere else to hear the chord',
    'sound.diagram.handpan': 'Click a field to hear that note, anywhere else to hear the chord',
    'sound.settings.click': 'Chord sound on click',
    'sound.settings.clickHint': 'The Listen button, chord shapes and P always play',
    'sound.settings.volume': 'Chord sound volume',
    'sound.settings.test': 'Play a chord',
    'sound.shortcut': 'Play the chord',
    'sound.handpan.none': 'None of the notes of {chord} are on this handpan',
    'sound.unavailable': 'This browser can’t play chord sounds',
  },
}
