/**
 * The admin page must not be framed (clickjacking): a <meta> CSP ignores frame-ancestors (ADR-0002), so the page leaves
 * a frame itself. Returns false when the page is framed (nothing may render); then it tries to load itself in the top
 * window, which a cross-origin top refuses (then the framed page just stays empty).
 */
export function breakOutOfFrame(win: Window = window): boolean {
  if (win.top === win.self) return true
  try {
    win.top!.location.href = win.location.href
  } catch {
    // a cross-origin top window cannot be navigated; rendering nothing is the fallback
  }
  return false
}
