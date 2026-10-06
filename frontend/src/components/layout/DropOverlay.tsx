import { AnimatePresence, motion } from 'framer-motion'
import { FileAudio } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { modalOpen } from '../../hooks/useHotkeys'
import { startFiles } from '../input/startFiles'

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

/** Full-window drop target on every page: drop audio/video anywhere to analyze it. */
export function DropOverlay() {
  const t = useT()
  const [active, setActive] = useState(false)
  const depth = useRef(0)

  useEffect(() => {
    const onEnter = (e: DragEvent) => {
      // the tour (or another dialog) is open: no overlay
      if (!hasFiles(e) || modalOpen()) return
      e.preventDefault()
      depth.current += 1
      setActive(true)
    }
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      // still prevented during a dialog: otherwise the browser would open the file in place of the app
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = modalOpen() ? 'none' : 'copy'
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setActive(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setActive(false)
      if (modalOpen()) return
      const files = e.dataTransfer?.files
      if (files?.length) startFiles(files)
    }
    const reset = () => {
      depth.current = 0
      setActive(false)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('blur', reset)
    }
  }, [])

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          className="pointer-events-none fixed inset-0 z-[80] flex items-center justify-center bg-bg/80 p-4 backdrop-blur-md sm:p-8"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          aria-hidden="true"
        >
          <motion.div
            className="flex size-full flex-col items-center justify-center gap-4 rounded-3xl border-2 border-dashed border-accent bg-accent-soft text-center"
            initial={{ scale: 0.98 }}
            animate={{ scale: 1 }}
            transition={{ duration: 0.15 }}
          >
            <FileAudio className="size-12 text-accent" strokeWidth={1.5} />
            <p className="font-display text-2xl font-semibold tracking-tight text-text sm:text-3xl">{t('core.drop.title')}</p>
            <p className="max-w-md px-4 text-muted">{t('core.drop.subtitle')}</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
