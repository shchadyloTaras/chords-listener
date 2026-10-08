import clsx from 'clsx'
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '../../components/ui/IconButton'
import * as adminApi from '../../lib/adminApi'
import { adminErrorMessage, AdminApiError } from '../../lib/adminApi'
import { INPUT_CLASS } from '../ui'
import type { AdminBanner, AdminDefaultLimits, AdminSettings, AdminSwitchName } from '../../types'
import { useAdminData } from '../useAdminData'
import { SWITCH_LABEL } from './labels'

/** The calls the screen makes (replaceable in tests). */
export type SettingsApi = Pick<typeof adminApi, 'getSettings' | 'setDefaultLimits' | 'setSwitch' | 'setBanner'>

const BANNER_MAX = 250

const LIMIT_FIELDS: ReadonlyArray<{
  name: keyof AdminDefaultLimits
  label: string
  min: number
  max: number
  /** shown beside the field: what is allowed */
  hint: string
  /** shown when the value is refused */
  range: string
}> = [
  { name: 'analyses', label: 'Аналізи на добу', min: 1, max: 1000, hint: 'Допустимо 1–1000 на користувача', range: 'від 1 до 1000' },
  { name: 'vocals', label: 'Транскрипції вокалу на добу', min: 1, max: 150, hint: 'Допустимо 1–150 на користувача', range: 'від 1 до 150' },
  { name: 'jobs', label: 'Одночасні задачі', min: 1, max: 4, hint: 'Допустимо 1–4 на користувача', range: 'від 1 до 4' },
  { name: 'maxDurationMin', label: 'Тривалість пісні, хв', min: 1, max: 120, hint: 'Допустимо 1–120 хвилин', range: 'від 1 до 120 хвилин' },
  {
    name: 'maxUploadMb',
    label: 'Розмір файлу, МБ',
    min: 1,
    max: 512,
    hint: 'Допустимо від 1 МБ до 512 МБ (0,5 ГБ — поточна межа сховища)',
    range: 'від 1 МБ до 512 МБ (0,5 ГБ)',
  },
]

type LimitsDraft = Record<keyof AdminDefaultLimits, string>

const limitsDraftOf = (l: AdminDefaultLimits): LimitsDraft => ({
  analyses: String(l.analyses),
  vocals: String(l.vocals),
  jobs: String(l.jobs),
  maxDurationMin: String(l.maxDurationMin),
  maxUploadMb: String(l.maxUploadMb),
})

/** The five values when every one is a whole number in its range; otherwise what is wrong, per field. */
function parseLimits(draft: LimitsDraft): { value: AdminDefaultLimits } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const value = {} as AdminDefaultLimits
  for (const f of LIMIT_FIELDS) {
    const raw = draft[f.name].trim()
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN
    if (Number.isInteger(n) && n >= f.min && n <= f.max) value[f.name] = n
    else errors[f.name] = `Допустимі значення: ${f.range}`
  }
  return Object.keys(errors).length ? { errors } : { value }
}

const BANNER_RULE = 'від 1 до 250 символів обома мовами'

const charCount = (s: string) => [...s].length
const bannerTextOk = (s: string) => {
  const n = charCount(s.trim())
  return n >= 1 && n <= BANNER_MAX
}

interface SwitchRow {
  name: AdminSwitchName
  label: string
  /** the switch is "on" when the thing it names is stopped (pause) rather than running */
  on: (s: AdminSettings['switches']) => boolean
  /** the value to send for the next click when the switch shows `on` */
  send: (on: boolean) => boolean
  text: string
  note?: string
}

const SWITCHES: readonly SwitchRow[] = [
  {
    name: 'analysesPaused',
    label: SWITCH_LABEL.analysesPaused,
    on: (s) => s.analysesPaused,
    send: (on) => !on,
    text: 'Нові хмарні аналізи (посилання й файли) не приймаються і не рахуються в квоту; користувач бачить пояснення й може розпізнати в браузері.',
    note: 'Щоб увімкнути паузу, потрібно повторно ввести пароль, якщо ви входили понад 15 хвилин тому. Вимкнення паузи пароля не просить.',
  },
  {
    name: 'youtubeEnabled',
    label: SWITCH_LABEL.youtubeEnabled,
    on: (s) => s.youtubeEnabled,
    send: (on) => !on,
    text: 'Вимкнено: сайт одразу пропонує «Слухати у вкладці», спроба не витрачається.',
  },
  {
    name: 'vocalsEnabled',
    label: SWITCH_LABEL.vocalsEnabled,
    on: (s) => s.vocalsEnabled,
    send: (on) => !on,
    text: 'Вимкнено: транскрипція вокалу тимчасово недоступна, акорди й бібліотека працюють як звичайно.',
  },
]

function Toggle({ label, checked, disabled, onChange, id }: { label: string; checked: boolean; disabled?: boolean; onChange(): void; id?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={clsx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border-strong transition-colors duration-150',
        'disabled:pointer-events-none disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-surface-3',
      )}
    >
      <span className={clsx('inline-block size-4 rounded-full bg-white shadow transition-transform duration-150', checked ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  )
}

function Card({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-2xl border border-border bg-surface-2 p-4 sm:p-5">
      <h2 id={id} className="mb-3 text-base font-semibold text-text">
        {title}
      </h2>
      {children}
    </section>
  )
}

function Problems({ items }: { items: string[] }) {
  if (!items.length) return null
  return (
    <div role="alert" className="mt-3 space-y-1 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      {items.map((m) => (
        <p key={m}>{m}</p>
      ))}
    </div>
  )
}

/** What a failed call says: the text of its code plus the server's per-field messages (labelled). */
function problemsOf(err: unknown, fieldLabels: Record<string, string>): string[] {
  const out = [adminErrorMessage(err)]
  if (err instanceof AdminApiError) {
    for (const [name, message] of Object.entries(err.fields)) out.push(`${fieldLabels[name] ?? name}: ${message}`)
  }
  return out
}

function LimitsCard({ settings, api, onSaved, idPrefix }: { settings: AdminSettings; api: SettingsApi; onSaved(s: AdminSettings): void; idPrefix: string }) {
  const [draft, setDraft] = useState<LimitsDraft | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const shown = draft ?? limitsDraftOf(settings.limits)
  const ids = useId()
  const labels = Object.fromEntries(LIMIT_FIELDS.map((f) => [f.name, f.label]))

  const edit = (name: keyof AdminDefaultLimits, value: string) => {
    setDraft({ ...shown, [name]: value })
    setSaved(false)
    setProblems([])
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSaved(false)
    const parsed = parseLimits(shown)
    if ('errors' in parsed) {
      setProblems(LIMIT_FIELDS.filter((f) => parsed.errors[f.name]).map((f) => `${f.label}: ${parsed.errors[f.name]}`))
      return
    }
    setProblems([])
    setBusy(true)
    try {
      const next = await api.setDefaultLimits(parsed.value)
      onSaved(next)
      setDraft(null)
      setSaved(true)
    } catch (err) {
      setProblems(problemsOf(err, labels))
    } finally {
      setBusy(false)
    }
  }

  const failing = problems.length ? parseLimits(shown) : null
  const failingNames = failing && 'errors' in failing ? failing.errors : {}

  return (
    <Card title="Типові ліміти" id={`${ids}-limits`}>
      <p className="mb-3 text-sm text-muted">
        Діють для всіх акаунтів без персонального ліміту, не пізніше ніж за хвилину, без повторного розгортання сервера. Щоб зупинити аналізи для
        всіх, не ставте 0: увімкніть перемикач «Пауза нових аналізів» нижче.{' '}
        <button
          type="button"
          className="text-accent underline underline-offset-2"
          onClick={() => document.getElementById(`${idPrefix}-analysesPaused`)?.focus()}
        >
          Перейти до перемикача
        </button>
      </p>
      <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
        {LIMIT_FIELDS.map((f) => (
          <div key={f.name}>
            <label htmlFor={`${ids}-${f.name}`} className="mb-1 block text-sm font-medium text-text">
              {f.label}
            </label>
            <input
              id={`${ids}-${f.name}`}
              inputMode="numeric"
              autoComplete="off"
              value={shown[f.name]}
              aria-invalid={Boolean(failingNames[f.name])}
              aria-describedby={`${ids}-${f.name}-hint`}
              onChange={(e) => edit(f.name, e.target.value)}
              className={INPUT_CLASS}
            />
            <p id={`${ids}-${f.name}-hint`} className="mt-1 text-xs text-muted">
              {f.hint}
            </p>
          </div>
        ))}
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="submit" variant="primary" disabled={busy}>
            Зберегти ліміти
          </Button>
          {saved && (
            <span role="status" className="text-sm text-success">
              Збережено
            </span>
          )}
        </div>
      </form>
      <Problems items={problems} />
    </Card>
  )
}

function SwitchesCard({ settings, api, onSaved, idPrefix }: { settings: AdminSettings; api: SettingsApi; onSaved(s: AdminSettings): void; idPrefix: string }) {
  const [busy, setBusy] = useState<AdminSwitchName | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const ids = useId()

  const flip = async (row: SwitchRow) => {
    setProblems([])
    setBusy(row.name)
    try {
      // the client asks for the password by itself when the server wants a fresh login (turning the pause on)
      onSaved(await api.setSwitch(row.name, row.send(row.on(settings.switches))))
    } catch (err) {
      setProblems(problemsOf(err, {}))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card title="Перемикачі сервісу" id={`${ids}-switches`}>
      <p className="mb-3 text-sm text-muted">Діють одразу. Прийняті задачі завершуються за будь-якого перемикача.</p>
      <ul className="divide-y divide-border">
        {SWITCHES.map((row) => (
          <li key={row.name} data-switch={row.name} className="flex items-start gap-4 py-3 first:pt-0 last:pb-0">
            <Toggle
              id={`${idPrefix}-${row.name}`}
              label={row.label}
              checked={row.on(settings.switches)}
              disabled={busy !== null}
              onChange={() => void flip(row)}
            />
            <div className="min-w-0">
              <p className="text-sm font-medium text-text">{row.label}</p>
              <p className="text-sm text-muted">{row.text}</p>
              {row.note && <p className="mt-1 text-xs text-muted">{row.note}</p>}
            </div>
          </li>
        ))}
      </ul>
      <Problems items={problems} />
    </Card>
  )
}

function BannerCard({ settings, api, onSaved }: { settings: AdminSettings; api: SettingsApi; onSaved(s: AdminSettings): void }) {
  const [draft, setDraft] = useState<AdminBanner | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const shown = draft ?? settings.banner
  const ids = useId()

  const edit = (patch: Partial<AdminBanner>) => {
    setDraft({ ...shown, ...patch })
    setSaved(false)
    setProblems([])
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSaved(false)
    if (!bannerTextOk(shown.uk) || !bannerTextOk(shown.en)) {
      setProblems([`Текст має бути ${BANNER_RULE}`])
      return
    }
    setProblems([])
    setBusy(true)
    try {
      onSaved(await api.setBanner({ enabled: shown.enabled, uk: shown.uk.trim(), en: shown.en.trim() }))
      setDraft(null)
      setSaved(true)
    } catch (err) {
      setProblems(problemsOf(err, { uk: 'Українською', en: 'English' }))
    } finally {
      setBusy(false)
    }
  }

  const texts = [
    { lang: 'uk' as const, label: 'Текст банера (українською)', caption: 'Українською' },
    { lang: 'en' as const, label: 'Текст банера (English)', caption: 'English' },
  ]

  return (
    <Card title="Банер обслуговування" id={`${ids}-banner`}>
      <p className="mb-3 text-sm text-muted">
        Звичайний текст, {BANNER_RULE}. Гості бачать банер мовою інтерфейсу, не будячи сервер; після вимкнення він зникає для нових відвідувань не
        пізніше ніж за 5 хвилин.
      </p>
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="flex items-center gap-3">
          <Toggle label="Показувати банер" checked={shown.enabled} onChange={() => edit({ enabled: !shown.enabled })} />
          <span className="text-sm text-text">Показувати банер</span>
        </div>
        {texts.map(({ lang, label }) => (
          <div key={lang}>
            <label htmlFor={`${ids}-${lang}`} className="mb-1 block text-sm font-medium text-text">
              {label}
            </label>
            <textarea
              id={`${ids}-${lang}`}
              rows={2}
              value={shown[lang]}
              aria-invalid={!bannerTextOk(shown[lang])}
              onChange={(e) => edit({ [lang]: e.target.value })}
              className={clsx(INPUT_CLASS, 'h-auto py-2')}
            />
            <p className="mt-1 text-xs text-muted">
              {charCount(shown[lang])} / {BANNER_MAX}
            </p>
          </div>
        ))}
        <div>
          <p className="mb-1 text-sm font-medium text-text">Як це побачать гості{shown.enabled ? '' : ' (банер вимкнено — зараз його не видно)'}</p>
          <div className={clsx('space-y-2 rounded-xl border border-border bg-surface-3 p-3 text-sm', !shown.enabled && 'opacity-60')}>
            {texts.map(({ lang, caption }) => (
              <div key={lang}>
                <p className="text-xs text-muted">{caption}</p>
                <p data-banner-preview={lang} className="break-words whitespace-pre-wrap text-text">
                  {shown[lang]}
                </p>
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={busy}>
            Опублікувати банер
          </Button>
          {saved && (
            <span role="status" className="text-sm text-success">
              Збережено
            </span>
          )}
        </div>
      </form>
      <Problems items={problems} />
    </Card>
  )
}

function SettingsForms({ loaded, loadedAt, api }: { loaded: AdminSettings; loadedAt: number | null; api: SettingsApi }) {
  // the newest answer wins: what a save returned, until a later load brings fresher data
  const [latest, setLatest] = useState<{ at: number; settings: AdminSettings } | null>(null)
  const settings = latest && latest.at >= (loadedAt ?? 0) ? latest.settings : loaded
  const onSaved = (s: AdminSettings) => setLatest({ at: Date.now(), settings: s })
  const ids = useId()
  return (
    <div className="space-y-5">
      <LimitsCard settings={settings} api={api} onSaved={onSaved} idPrefix={ids} />
      <SwitchesCard settings={settings} api={api} onSaved={onSaved} idPrefix={ids} />
      <BannerCard settings={settings} api={api} onSaved={onSaved} />
    </div>
  )
}

/** «Налаштування»: default limits (US-12), service switches (US-13) and the maintenance banner (US-14). */
export function Settings({ api = adminApi }: { api?: SettingsApi }) {
  const { data, error, loadedAt, refresh } = useAdminData((signal) => api.getSettings(signal), 'settings')

  return (
    <div className="px-4 py-6">
      <h1 className="mb-4 text-xl font-semibold text-text">Налаштування</h1>
      {data ? (
        <SettingsForms loaded={data} loadedAt={loadedAt} api={api} />
      ) : error ? (
        <div role="alert" className="space-y-3 text-sm text-danger">
          <p>{adminErrorMessage(error)}</p>
          <Button onClick={refresh}>Спробувати ще раз</Button>
        </div>
      ) : (
        <p className="text-sm text-muted">Завантаження…</p>
      )}
    </div>
  )
}
