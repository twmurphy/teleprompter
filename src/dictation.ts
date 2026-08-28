/** The stretch of text the current utterance has written, so it can be revised. */
export type Pending = { id: string; text: string; start: number } | null

/** A document edit produced by dictation. */
export type SpeechEdit = { body: string; caret: number; pending: Pending }

/**
 * Apply dictated words to a document.
 *
 * Speech does not arrive as a series of separate phrases. An utterance grows and
 * is revised — "hello", then "hello my", then "hello my name" — and on Android
 * each growth can arrive as a settled result with a fresh id, so treating them
 * as new phrases writes the sentence once per word.
 *
 * What an utterance writes is therefore treated as a region that it owns and may
 * rewrite, rather than as an append. A later update replaces that region when it
 * carries the same id or simply extends what is already there; anything else is
 * new speech and is inserted after it.
 *
 * Returns null when there is nothing to do.
 */
export function applySpeech(
  body: string,
  caret: number,
  spoken: string,
  id: string,
  pending: Pending,
): SpeechEdit | null {
  const phrase = spoken.trim()
  if (!phrase) return null

  // The region is only ours if it still reads as we left it; the writer may have
  // typed in the meantime.
  const intact =
    pending !== null &&
    body.slice(pending.start, pending.start + pending.text.length) === pending.text

  if (intact && pending !== null) {
    const revises = pending.id === id || phrase.startsWith(pending.text)
    if (revises) {
      if (phrase === pending.text) return null // nothing changed
      const end = pending.start + pending.text.length
      return {
        body: body.slice(0, pending.start) + phrase + body.slice(end),
        caret: pending.start + phrase.length,
        pending: { id, text: phrase, start: pending.start },
      }
    }
  }

  // New speech follows the region just written, which is where dictation
  // naturally continues. If the caret has been moved away from there, the
  // writer has gone somewhere else and that wins.
  const clamped = Math.max(0, Math.min(caret, body.length))
  const end = intact && pending !== null ? pending.start + pending.text.length : -1
  const continuing =
    intact && pending !== null && clamped >= pending.start && clamped <= end
  const at = continuing ? end : clamped

  const before = body.slice(0, at)
  const separator = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
  const start = at + separator.length

  return {
    body: before + separator + phrase + body.slice(at),
    caret: start + phrase.length,
    pending: { id, text: phrase, start },
  }
}
