import { useT } from '../../i18n'
import { navigate, paths } from '../../hooks/useRoute'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { Button } from '../ui/IconButton'

export function NotFoundPage() {
  const t = useT()
  useDocumentTitle(t('core.notFound.title'))
  return (
    <div className="mx-auto max-w-md px-4 pt-24 text-center">
      <h1 className="font-display text-3xl font-semibold tracking-tight">{t('core.notFound.title')}</h1>
      <p className="mt-3 text-muted">{t('core.notFound.hint')}</p>
      <Button variant="primary" className="mt-6" onClick={() => navigate(paths.home())}>
        {t('core.job.backHome')}
      </Button>
    </div>
  )
}
