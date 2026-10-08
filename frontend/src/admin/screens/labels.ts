import type { AdminFailureReason, AdminOrigin } from '../../types'

export const REASONS: readonly AdminFailureReason[] = ['youtube_blocked', 'download_failed', 'unsupported_format', 'too_long', 'too_large', 'analysis_failed', 'other']

export const ORIGIN_LABEL: Record<AdminOrigin, string> = { link: 'Посилання', file: 'Файл', mic: 'Мікрофон', tab: 'Вкладка' }
