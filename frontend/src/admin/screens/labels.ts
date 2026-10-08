import type { AdminFailureReason, AdminHistoryStatus, AdminJobKind, AdminOrigin, AdminSourceType, AdminSwitchName } from '../../types'

// One word per thing across the admin screens (Ukrainian only, like the rest of the page: ADR-0002), in the spec's
// terms: a job's result is «успішна» / «невдала» / «виконується» (AC-07), the switches are named as in US-13.

export const REASONS: readonly AdminFailureReason[] = ['youtube_blocked', 'download_failed', 'unsupported_format', 'too_long', 'too_large', 'analysis_failed', 'other']

export const ORIGIN_LABEL: Record<AdminOrigin, string> = { link: 'Посилання', file: 'Файл', mic: 'Мікрофон', tab: 'Вкладка' }

export const SOURCE_TYPE_LABEL: Record<AdminSourceType, string> = { youtube: 'YouTube', other: 'Інше' }

export const KIND_LABEL: Record<AdminJobKind, string> = { analysis: 'Аналіз', vocals: 'Вокал' }

/** The result of a job (job history, the user card's recent jobs). */
export const STATUS_LABEL: Record<AdminHistoryStatus, string> = { running: 'Виконується', done: 'Успішна', error: 'Невдала' }

/** The service switches (overview, settings, journal). */
export const SWITCH_LABEL: Record<AdminSwitchName, string> = {
  analysesPaused: 'Пауза нових аналізів',
  youtubeEnabled: 'Завантаження з YouTube на сервері',
  vocalsEnabled: 'Транскрипція вокалу',
}
