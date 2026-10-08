import { Info } from 'lucide-react'
import { useEffect } from 'react'
import { HOSTED, useConnection } from '../../lib/serverMode'
import { bannerText, loadServiceStatus, useServiceStatus } from '../../lib/serviceStatus'
import { useApp } from '../../store'

/**
 * The admin's maintenance notice (Firestore publicStatus/current), in the interface language, as plain text.
 * Read straight from Firestore (never from the cloud server, so showing it does not wake it), at most once per
 * 5 minutes. Only the hosted site and the cloud have an admin to announce anything: the local app (./start.sh)
 * reads nothing.
 */
export function ServiceBanner() {
  const lang = useApp((s) => s.lang)
  const cloud = useConnection((s) => s.backend === 'cloud')
  const status = useServiceStatus((s) => s.status)
  const announced = HOSTED || cloud

  useEffect(() => {
    if (announced) void loadServiceStatus()
  }, [announced])

  const text = announced ? bannerText(status, lang) : null
  if (!text) return null
  return (
    <div role="status" className="border-b border-accent/25 bg-accent-soft">
      <div className="mx-auto flex max-w-7xl items-start gap-2.5 px-4 py-2.5 text-sm sm:px-6">
        <Info className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
        <span className="min-w-0 break-words whitespace-pre-line text-text">{text}</span>
      </div>
    </div>
  )
}
