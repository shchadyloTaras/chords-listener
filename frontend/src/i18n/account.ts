import type { Dict } from './index'

// Account / sign-in UI. Keys prefixed "account.". Ukrainian first (default), English mirrors it.
export const account: Dict = {
  uk: {
    'account.signIn': 'Увійти',
    'account.signOut': 'Вийти',
    'account.menu': 'Акаунт',
    'account.signedInAs': 'Акаунт {email}',
    'account.synced': 'Налаштування синхронізуються між пристроями',
    'account.intro.signIn': 'Увійди, щоб тема, мова, інструмент і вигляд акордів були однакові на всіх твоїх пристроях.',
    'account.intro.signUp': 'Акаунт потрібен лише для того, щоб налаштування були однакові на всіх твоїх пристроях. Пісні й акорди лишаються на цьому пристрої.',
    'account.intro.reset': 'Введи пошту акаунта — надішлемо посилання для нового пароля.',

    'account.title.signIn': 'Вхід',
    'account.title.signUp': 'Новий акаунт',
    'account.title.reset': 'Скидання пароля',

    'account.email': 'Електронна пошта',
    'account.password': 'Пароль',
    'account.passwordHint': 'Щонайменше 6 символів',
    'account.showPassword': 'Показати пароль',
    'account.hidePassword': 'Сховати пароль',

    'account.submit.signIn': 'Увійти',
    'account.submit.signUp': 'Створити акаунт',
    'account.submit.reset': 'Надіслати лист',

    'account.forgot': 'Забув пароль?',
    'account.noAccount': 'Ще немає акаунта?',
    'account.toSignUp': 'Створити',
    'account.haveAccount': 'Вже є акаунт?',
    'account.toSignIn': 'Увійти',
    'account.backToSignIn': 'Повернутися до входу',
    'account.resetSent': 'Якщо акаунт з адресою {email} існує, на неї вже йде лист із посиланням для скидання пароля.',

    'account.welcome': 'Вхід виконано · {email}',
    'account.welcomeNew': 'Акаунт створено · {email}',
    'account.signedOut': 'Вихід виконано',
    'account.syncError': 'Не вдалося синхронізувати налаштування',

    'account.error.invalidEmail': 'Перевір адресу електронної пошти.',
    'account.error.missingPassword': 'Введи пароль.',
    'account.error.weakPassword': 'Пароль надто короткий — потрібно щонайменше 6 символів.',
    'account.error.emailInUse': 'Акаунт із цією адресою вже існує. Спробуй увійти.',
    'account.error.invalidCredential': 'Неправильна пошта або пароль.',
    'account.error.tooManyRequests': 'Забагато спроб. Зачекай трохи й спробуй ще раз.',
    'account.error.network': 'Не вдалося звʼязатися зі службою входу. Перевір інтернет.',
    'account.error.userDisabled': 'Цей акаунт вимкнено.',
    'account.error.generic': 'Щось пішло не так. Спробуй ще раз.',
  },
  en: {
    'account.signIn': 'Sign in',
    'account.signOut': 'Sign out',
    'account.menu': 'Account',
    'account.signedInAs': 'Account {email}',
    'account.synced': 'Settings sync across your devices',
    'account.intro.signIn': 'Sign in to keep your theme, language, instrument and chord view the same on every device.',
    'account.intro.signUp': 'An account only keeps your settings the same on every device. Songs and chords stay on this device.',
    'account.intro.reset': 'Enter your account email and we will send a link to set a new password.',

    'account.title.signIn': 'Sign in',
    'account.title.signUp': 'Create account',
    'account.title.reset': 'Reset password',

    'account.email': 'Email',
    'account.password': 'Password',
    'account.passwordHint': 'At least 6 characters',
    'account.showPassword': 'Show password',
    'account.hidePassword': 'Hide password',

    'account.submit.signIn': 'Sign in',
    'account.submit.signUp': 'Create account',
    'account.submit.reset': 'Send email',

    'account.forgot': 'Forgot password?',
    'account.noAccount': 'No account yet?',
    'account.toSignUp': 'Create one',
    'account.haveAccount': 'Already have an account?',
    'account.toSignIn': 'Sign in',
    'account.backToSignIn': 'Back to sign in',
    'account.resetSent': 'If an account exists for {email}, a password reset link is on its way.',

    'account.welcome': 'Signed in · {email}',
    'account.welcomeNew': 'Account created · {email}',
    'account.signedOut': 'Signed out',
    'account.syncError': 'Could not sync settings',

    'account.error.invalidEmail': 'Check the email address.',
    'account.error.missingPassword': 'Enter your password.',
    'account.error.weakPassword': 'Password is too short — use at least 6 characters.',
    'account.error.emailInUse': 'An account with this email already exists. Try signing in.',
    'account.error.invalidCredential': 'Wrong email or password.',
    'account.error.tooManyRequests': 'Too many attempts. Wait a bit and try again.',
    'account.error.network': 'Can’t reach the sign-in service. Check your internet connection.',
    'account.error.userDisabled': 'This account has been disabled.',
    'account.error.generic': 'Something went wrong. Please try again.',
  },
}
