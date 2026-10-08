import type { AdminFailureReason, AdminJobKind, AdminOrigin, AdminSourceType } from '../../types'

export const REASONS: readonly AdminFailureReason[] = ['youtube_blocked', 'download_failed', 'unsupported_format', 'too_long', 'too_large', 'analysis_failed', 'other']

export const ORIGIN_LABEL: Record<AdminOrigin, string> = { link: 'Посилання', file: 'Файл', mic: 'Мікрофон', tab: 'Вкладка' }

export const SOURCE_TYPE_LABEL: Record<AdminSourceType, string> = { youtube: 'YouTube', other: 'Інше' }

export const KIND_LABEL: Record<AdminJobKind, string> = { analysis: 'Аналіз', vocals: 'Вокал' }
