/**
 * Word matching between the script and what the speech engine hears.
 *
 * This is a port of the algorithm from Tom's existing teleprompter, which
 * tracks reliably in practice. The details that matter are load-bearing:
 *
 *  - The search window is narrow and symmetric. That is what keeps it steady
 *    when the engine re-sends an utterance as it firms up: words already spoken
 *    fall outside the window and are ignored instead of advancing the cursor a
 *    second time. Widening it makes the highlight jump.
 *  - Matching is exact. Loose matching lets those re-sent words match again.
 */

/** A single script word, keeping its original form for display. */
export type ScriptWord = {
  /** Text as written, including punctuation. */
  raw: string
  /** Normalised form used for comparison. */
  key: string
  /** Character offset in the source text, so we can rebuild whitespace. */
  start: number
}

/** Lowercase, drop trailing punctuation and surrounding emphasis markers. */
export const normalize = (word: string): string =>
  word
    .toLowerCase()
    .replace(/[.,?!;:*]+$/g, '')
    .replace(/^\*|\*$/g, '')

/** Split raw script text into comparable words, preserving source offsets. */
export function parseScript(text: string): ScriptWord[] {
  const words: ScriptWord[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const key = normalize(m[0])
    // Tokens that normalise to nothing can never match; keeping them would
    // only eat into the seek range.
    if (key) words.push({ raw: m[0], key, start: m.index })
  }
  return words
}

/** Split a transcript into normalised words. */
export const transcriptWords = (text: string): string[] =>
  text.toLowerCase().split(/\s+/).map(normalize).filter(Boolean)

/**
 * How far either side of the cursor to look. Deliberately small: a wide window
 * lets words the engine re-sends match a later copy of themselves.
 */
export const SEEK_RANGE = 5

/**
 * Weight for a candidate whose following word also matches what was said next.
 * A lone common word is weak evidence — "the" appears everywhere, and letting
 * one drag the cursor is how tracking drifts. The same word backed by its
 * neighbour is strong evidence, so a confirmed candidate outranks any
 * unconfirmed one however close.
 */
const PAIR_BONUS = 4

/** Words too common to move the cursor on their own evidence. */
const COMMON = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in',
  'is', 'it', 'of', 'on', 'or', 'so', 'that', 'the', 'to', 'was', 'we', 'you',
])

/**
 * Advance `cursor` through `script` for each spoken word.
 *
 * Candidates are scored by closeness (`1 / offset`), and heavily favoured when
 * the next spoken word also lands on the next script word. A common word with
 * no such confirmation may only match where it was already expected, so it can
 * confirm a position but never choose one.
 *
 * Words matching nothing are ignored, which is what makes re-sent and misheard
 * words harmless.
 */
export function advanceCursor(
  script: ScriptWord[],
  cursor: number,
  heard: string[],
  seekRange: number = SEEK_RANGE,
): number {
  let position = cursor

  for (let h = 0; h < heard.length; h++) {
    const word = heard[h]
    const following = heard[h + 1]

    let bestPosition = -1
    let bestWeight = 0

    for (let offset = 0; offset <= seekRange; offset++) {
      for (const candidate of offset === 0
        ? [position]
        : [position + offset, position - offset]) {
        if (candidate < 0 || candidate >= script.length) continue

        if (script[candidate].key !== word) continue

        const confirmed =
          following !== undefined &&
          candidate + 1 < script.length &&
          script[candidate + 1].key === following

        // An unconfirmed common word is not evidence of a new position.
        if (!confirmed && offset > 0 && COMMON.has(word)) continue

        const distance = candidate >= position ? offset : offset * 2
        const weight = (1 / (1 + distance)) * (confirmed ? PAIR_BONUS : 1)

        if (weight > bestWeight) {
          bestWeight = weight
          bestPosition = candidate
        }
      }
    }

    // Move on immediately so later words in the same batch search from here.
    if (bestPosition >= 0) position = bestPosition + 1
  }

  return position
}
