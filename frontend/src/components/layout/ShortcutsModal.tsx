import { Fragment } from 'react'
import { useT } from '../../i18n'
import { Kbd } from '../ui/Kbd'
import { Modal } from '../ui/Modal'

type Shortcut = { keys: string[][]; label: string }

/** Every shortcut from SPEC (Shell + chord view), grouped. `keys`: alternatives of key combos. */
function useGroups(): Array<{ title: string; items: Shortcut[] }> {
  const t = useT()
  const space = t('core.keys.space')
  return [
    {
      title: t('core.shortcuts.playback'),
      items: [
        { keys: [[space]], label: t('core.shortcuts.playPause') },
        { keys: [['←'], ['→']], label: t('core.shortcuts.seek') },
        { keys: [['Shift', '←'], ['Shift', '→']], label: t('core.shortcuts.chordJump') },
        { keys: [[','], ['.']], label: t('core.shortcuts.speed') },
        { keys: [['M']], label: t('core.shortcuts.mute') },
      ],
    },
    {
      title: t('core.shortcuts.chords'),
      items: [
        { keys: [['−'], ['='], ['['], [']']], label: t('core.shortcuts.transpose') },
        { keys: [['0']], label: t('core.shortcuts.transposeReset') },
        { keys: [['S']], label: t('core.shortcuts.simplify') },
        { keys: [['V']], label: t('core.shortcuts.view') },
        { keys: [['C']], label: t('core.shortcuts.copy') },
        { keys: [['F']], label: t('core.shortcuts.follow') },
        { keys: [['L']], label: t('core.shortcuts.loop') },
        { keys: [['I']], label: t('core.shortcuts.instrument') },
        { keys: [['P']], label: t('sound.shortcut') },
      ],
    },
    {
      title: t('tempo.shortcuts.group'),
      items: [
        { keys: [['T']], label: t('tempo.shortcuts.tap') },
        { keys: [['K']], label: t('tempo.shortcuts.metronome') },
      ],
    },
    {
      title: t('core.shortcuts.general'),
      items: [
        { keys: [['?']], label: t('core.shortcuts.help') },
        { keys: [['Esc']], label: t('core.shortcuts.escape') },
      ],
    },
  ]
}

export function ShortcutsModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const t = useT()
  const groups = useGroups()
  return (
    <Modal open={open} onClose={onClose} title={t('core.shortcuts.title')} width="max-w-2xl">
      <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
        {groups.map((g) => (
          <section key={g.title} className={g.items.length > 6 ? 'sm:row-span-2' : undefined}>
            <h3 className="mb-2 text-sm font-medium text-muted">{g.title}</h3>
            <dl className="divide-y divide-border">
              {g.items.map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-4 py-2">
                  <dt className="text-sm text-text">{item.label}</dt>
                  <dd className="flex shrink-0 items-center gap-1 text-xs text-faint">
                    {item.keys.map((combo, i) => (
                      <Fragment key={i}>
                        {i > 0 && <span className="px-0.5">/</span>}
                        {combo.map((k, j) => (
                          <Fragment key={k}>
                            {j > 0 && <span>+</span>}
                            <Kbd>{k}</Kbd>
                          </Fragment>
                        ))}
                      </Fragment>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="mt-5 text-sm text-faint">{t('core.shortcuts.note')}</p>
    </Modal>
  )
}
