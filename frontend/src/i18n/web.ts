import type { Dict } from './index'

// Owned by the "web" agent (GitHub Pages / server modes). Keys prefixed "web.".
export const web: Dict = {
  uk: {
    'web.mode.title': 'Режим роботи',
    'web.mode.server': 'Локальний сервер',
    'web.mode.browser': 'Браузерний режим',
    'web.mode.checking': 'Шукаю сервер…',
    'web.mode.aria': 'Режим роботи: {mode}. Відкрити налаштування зʼєднання',

    'web.server.connected': 'Підключено до {url}',
    'web.server.what': 'Посилання на YouTube, файли й записи з мікрофона розпізнає програма на твоєму компʼютері.',
    'web.server.engine': 'Рушій: {engine}',
    'web.browser.what':
      'Файли й записи з мікрофона розпізнаються прямо в браузері та зберігаються лише на цьому пристрої.',
    'web.browser.needServer': 'Для посилань на YouTube потрібен локальний сервер.',
    'web.browser.localNote': 'Пісні, розпізнані в браузері, лишаються на цьому пристрої.',

    'web.guide.title': 'Як підключити локальний сервер',
    'web.guide.step1': 'Один раз завантаж програму (потрібні git, ffmpeg, uv і Node.js — дивись README):',
    'web.guide.step2': 'Запусти сервер і не закривай термінал:',
    'web.guide.step3': 'Натисни «Перевірити зʼєднання». Якщо браузер спитає про доступ до локальної мережі — дозволь.',
    'web.guide.copy': 'Скопіювати команду',
    'web.guide.copied': 'Скопійовано',
    'web.guide.direct': 'Або відкрий програму напряму:',

    'web.check': 'Перевірити зʼєднання',
    'web.checking': 'Перевіряю…',
    'web.address.label': 'Адреса сервера',
    'web.address.save': 'Зберегти',
    'web.address.default': 'Типова адреса',
    'web.address.invalid': 'Введи адресу на кшталт http://localhost:8765',

    'web.status.ok': 'Зʼєднання є',
    'web.status.unreachable': 'Сервер за адресою {url} не відповідає. Перевір, що ./start.sh запущено.',
    'web.status.permission':
      'Щоб зʼєднатися з {url}, браузер попросить дозвіл на доступ до локальної мережі. Натисни «Перевірити зʼєднання» й дозволь.',
    'web.status.blocked':
      'Браузер заборонив цьому сайту доступ до локальної мережі. Дозволь його в налаштуваннях сайту (значок ліворуч від адреси) і перевір ще раз.',
    'web.status.invalidUrl': 'Адреса сервера некоректна.',
    'web.status.notChords': 'За адресою {url} відповідає не Chords Listener. Перевір порт.',

    'web.input.needServer': 'Для посилань потрібен локальний сервер на твоєму компʼютері.',
    'web.input.serverReady': 'Сервер підключено — натисни Enter, щоб розпізнати.',
    'web.input.dismiss': 'Сховати',

    'web.toast.connected': 'Локальний сервер підключено',
    'web.toast.disconnected': 'Локальний сервер недоступний — працюю в браузері',

    'web.history.local': 'На цьому пристрої',
    'web.history.localHint': 'Розпізнано в браузері й збережено лише на цьому пристрої',

    'web.error.serverRequired':
      'Посилання розпізнає лише локальний сервер. Запусти його на компʼютері — інструкція в меню «Браузерний режим» угорі.',
    'web.errorTitle.serverRequired': 'Потрібен локальний сервер',
  },
  en: {
    'web.mode.title': 'How it runs',
    'web.mode.server': 'Local server',
    'web.mode.browser': 'Browser mode',
    'web.mode.checking': 'Looking for the server…',
    'web.mode.aria': 'Mode: {mode}. Open connection settings',

    'web.server.connected': 'Connected to {url}',
    'web.server.what': 'YouTube links, files and microphone recordings are analyzed by the app on your computer.',
    'web.server.engine': 'Engine: {engine}',
    'web.browser.what': 'Files and microphone recordings are analyzed right in the browser and stay on this device.',
    'web.browser.needServer': 'YouTube links need the local server.',
    'web.browser.localNote': 'Songs analyzed in the browser stay on this device.',

    'web.guide.title': 'Connect the local server',
    'web.guide.step1': 'Get the app once (needs git, ffmpeg, uv and Node.js — see the README):',
    'web.guide.step2': 'Start the server and keep the terminal open:',
    'web.guide.step3': 'Press “Check connection”. If the browser asks about local network access, allow it.',
    'web.guide.copy': 'Copy command',
    'web.guide.copied': 'Copied',
    'web.guide.direct': 'Or open the app directly:',

    'web.check': 'Check connection',
    'web.checking': 'Checking…',
    'web.address.label': 'Server address',
    'web.address.save': 'Save',
    'web.address.default': 'Default address',
    'web.address.invalid': 'Enter an address like http://localhost:8765',

    'web.status.ok': 'Connected',
    'web.status.unreachable': 'No answer from {url}. Make sure ./start.sh is running.',
    'web.status.permission':
      'To reach {url} the browser will ask for local network access. Press “Check connection” and allow it.',
    'web.status.blocked':
      'The browser blocked local network access for this site. Allow it in the site settings (icon left of the address) and check again.',
    'web.status.invalidUrl': 'The server address is not valid.',
    'web.status.notChords': 'Something other than Chords Listener answers at {url}. Check the port.',

    'web.input.needServer': 'Links need the local server on your computer.',
    'web.input.serverReady': 'Server connected — press Enter to detect the chords.',
    'web.input.dismiss': 'Hide',

    'web.toast.connected': 'Local server connected',
    'web.toast.disconnected': 'Local server unavailable — working in the browser',

    'web.history.local': 'On this device',
    'web.history.localHint': 'Analyzed in the browser and stored only on this device',

    'web.error.serverRequired':
      'Links are analyzed by the local server only. Start it on your computer — see “Browser mode” at the top.',
    'web.errorTitle.serverRequired': 'Local server needed',
  },
}
