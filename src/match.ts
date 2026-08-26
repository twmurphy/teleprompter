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
 * How far either side of the cursor to look. Deliberately small — see above.
 * Larger values track sloppier reading but make the highlight jumpy.
 */
export const SEEK_RANGE = 5

/**
 * Advance `cursor` through `script` for each spoken word.
 *
 * Candidates are scored by `1 / offset`, so the nearest match wins; a hit
 * directly under the cursor short-circuits. Forward and backward are weighted
 * equally, with ties going to the forward match. Words matching nothing in the
 * window are ignored, which is what makes re-sent and misheard words harmless.
 */
export function advanceCursor(
  script: ScriptWord[],
  cursor: number,
  heard: string[],
  seekRange: number = SEEK_RANGE,
): number {
  let position = cursor

  for (const word of heard) {
    let bestPosition = -1
    let bestWeight = 0

    for (let offset = 0; offset <= seekRange; offset++) {
      const ahead = position + offset < script.length ? script[position + offset].key : null
      const behind = position - offset >= 0 ? script[position - offset].key : null

      if (offset === 0) {
        if (ahead === word) {
          bestPosition = position
          bestWeight = 1
          break
        }
        continue
      }

      const weight = 1 / offset
      if (ahead === word && weight > bestWeight) {
        bestPosition = position + offset
        bestWeight = weight
      }
      if (behind === word && weight > bestWeight) {
        bestPosition = position - offset
        bestWeight = weight
      }
    }

    // Move on immediately so later words in the same batch search from here.
    if (bestPosition >= 0) position = bestPosition + 1
  }

  return position
}
