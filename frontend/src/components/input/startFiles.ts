import { submitFile } from '../../hooks/useJobs'
import { useApp } from '../../store'
import { errorText } from '../jobs/errorText'
import { isMediaFile } from './url'

/** Starts an upload for each audio/video file; warns when none of them is media. */
export function startFiles(files: FileList | File[]) {
  const list = Array.from(files)
  const media = list.filter(isMediaFile)
  if (list.length && !media.length) {
    useApp.getState().toast(errorText('unsupported_format'), 'error')
    return
  }
  media.forEach((f) => void submitFile(f))
}
