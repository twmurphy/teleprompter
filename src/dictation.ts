/** Where dictated words landed, and where the caret should sit afterwards. */
export type Insertion = { body: string; caret: number }

/**
 * Place spoken words into `body` at `caret`.
 *
 * Speech arrives as bare words with no leading space, so one is added unless
 * the text already ends in whitespace — otherwise dictating after a word runs
 * straight into it. Nothing is added at the start of an empty document, or when
 * the caret follows a line break, so dictation does not indent paragraphs.
 */
export function insertSpoken(body: string, caret: number, spoken: string): Insertion {
  const at = Math.max(0, Math.min(caret, body.length))
  const before = body.slice(0, at)
  const separator = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
  const insertion = separator + spoken

  return {
    body: before + insertion + body.slice(at),
    caret: at + insertion.length,
  }
}

/**
 * Whether `spoken` has just been written already.
 *
 * A recognition restart can re-deliver the tail of what it already heard as a
 * fresh utterance, with a legitimately new id — so identity cannot catch it and
 * the text has to. Compared against what precedes the caret rather than the
 * whole document, so repeating a phrase later in a script is still allowed.
 */
export function alreadyWritten(body: string, caret: number, spoken: string): boolean {
  const phrase = spoken.trim()
  if (!phrase) return true
  const before = body.slice(0, Math.max(0, Math.min(caret, body.length))).trimEnd()
  return before.endsWith(phrase)
}
