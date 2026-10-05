import type { Dict } from './index'

// Where the app runs: cloud / browser mode / local server, the mode popover. Keys prefixed "web.".
export const web: Dict = {
  uk: {
    'web.mode.title': 'Режим роботи',
    'web.mode.cloud': 'Хмара',
    'web.mode.server': 'Локальний сервер',
    'web.mode.browser': 'Браузерний режим',
    'web.mode.checking': 'Підключаюсь…',
    'web.mode.aria': 'Режим роботи: {mode}. Відкрити налаштування зʼєднання',

    'web.cloud.what': 'Пісні розпізнає сервер у хмарі, а бібліотека зберігається у твоєму акаунті — її видно на всіх пристроях.',
    'web.cloud.account': 'Акаунт: {email}',
    'web.cloud.waking': 'Хмара прокидається — перший запит може тривати до хвилини.',
    'web.cloud.down': 'Хмара зараз не відповідає. Спробуй ще раз трохи згодом.',
    'web.cloud.check': 'Перевірити',
    'web.cloud.limits': 'До 2 аналізів одночасно, ліміт на день — щоб сервіс лишався безкоштовним.',

    'web.server.connected': 'Підключено до {url}',
    'web.server.what': 'Посилання на YouTube, файли й записи з мікрофона розпізнає програма на твоєму компʼютері.',
    'web.browser.what':
      'Файли й записи з мікрофона розпізнаються прямо в браузері та зберігаються лише на цьому пристрої.',
    'web.browser.cta': 'Увійди — і отримаєш точніші акорди, вокал і бібліотеку на всіх пристроях.',
    // the mode popover, where this browser can listen to its tab (there is no link field to press Enter in)
    'web.browser.youtube': 'Відео з YouTube слухаємо прямо на сторінці.',
    'web.browser.localNote': 'Пісні, розпізнані в браузері, лишаються на цьому пристрої.',

    'web.advanced.summary': 'Розширено: власний сервер',
    'web.advanced.what':
      'Необовʼязково. Якщо запустиш Chords Listener на своєму компʼютері (./start.sh), сайт без акаунта може працювати через нього.',
    'web.advanced.cloudFirst':
      'Поки ти в акаунті, пісні розпізнає хмара. Власний сервер використовується без акаунта — або відкрий його напряму:',
    'web.advanced.disable': 'Не використовувати власний сервер',

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

    'web.input.needServer': 'Посилання з цього сайту розпізнає хмара — увійди або зареєструйся.',
    'web.input.serverReady': 'Хмару підключено — натисни Enter, щоб розпізнати.',
    'web.input.sending': 'Надсилаю посилання…',
    'web.input.dismiss': 'Сховати',

    'web.toast.connected': 'Локальний сервер підключено',
    'web.toast.disconnected': 'Локальний сервер недоступний — працюю в браузері',

    'web.history.local': 'На цьому пристрої',
    'web.history.localHint': 'Розпізнано в браузері й збережено лише на цьому пристрої',

    'web.error.serverRequired':
      'Посилання з цього сайту розпізнає сервер у хмарі — увійди або зареєструйся, це безкоштовно. Відео з YouTube можна послухати й без акаунта.',
    // the same where this browser cannot listen to a tab (phones, Safari, Firefox): no "YouTube without an account"
    // promise there (the capture page offers the microphone, a file, or a computer instead)
    'web.error.serverRequiredNoTab':
      'Посилання розпізнає сервер у хмарі — увійди або зареєструйся, це безкоштовно. Файли й мікрофон працюють і без акаунта.',
    'web.errorTitle.serverRequired': 'Потрібен акаунт',
  },
  en: {
    'web.mode.title': 'How it runs',
    'web.mode.cloud': 'Cloud',
    'web.mode.server': 'Local server',
    'web.mode.browser': 'Browser mode',
    'web.mode.checking': 'Connecting…',
    'web.mode.aria': 'Mode: {mode}. Open connection settings',

    'web.cloud.what': 'Songs are analyzed by a cloud server and your library lives in your account — on every device.',
    'web.cloud.account': 'Account: {email}',
    'web.cloud.waking': 'The cloud is waking up — the first request can take up to a minute.',
    'web.cloud.down': 'The cloud is not responding right now. Try again a bit later.',
    'web.cloud.check': 'Check',
    'web.cloud.limits': 'Up to 2 analyses at a time and a daily limit — that keeps the service free.',

    'web.server.connected': 'Connected to {url}',
    'web.server.what': 'YouTube links, files and microphone recordings are analyzed by the app on your computer.',
    'web.browser.what': 'Files and microphone recordings are analyzed right in the browser and stay on this device.',
    'web.browser.cta': 'Sign in for more precise chords, vocals and your library on every device.',
    'web.browser.youtube': 'YouTube videos are listened to right on the page.',
    'web.browser.localNote': 'Songs analyzed in the browser stay on this device.',

    'web.advanced.summary': 'Advanced: your own server',
    'web.advanced.what':
      'Optional. If you run Chords Listener on your computer (./start.sh), the site can use it while you are signed out.',
    'web.advanced.cloudFirst':
      'While you are signed in, songs are analyzed in the cloud. Your own server is used when signed out — or open it directly:',
    'web.advanced.disable': 'Stop using my own server',

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

    'web.input.needServer': 'Links to this site are analyzed in the cloud — sign in or create an account.',
    'web.input.serverReady': 'Cloud connected — press Enter to detect the chords.',
    'web.input.sending': 'Sending the link…',
    'web.input.dismiss': 'Hide',

    'web.toast.connected': 'Local server connected',
    'web.toast.disconnected': 'Local server unavailable — working in the browser',

    'web.history.local': 'On this device',
    'web.history.localHint': 'Analyzed in the browser and stored only on this device',

    'web.error.serverRequired':
      'Links to this site are analyzed by a cloud server — sign in or create a free account. YouTube videos can be listened to without one.',
    'web.error.serverRequiredNoTab':
      'Links are analyzed by a cloud server — sign in or create a free account. Files and the microphone work without one.',
    'web.errorTitle.serverRequired': 'Account needed',
  },
}
