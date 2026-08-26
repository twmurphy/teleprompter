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
 * How much of what was just said to align. Long enough to be distinctive,
 * short enough that it is still about where you are now.
 */
const PHRASE = 8

/**
 * Search window. Wider than a single-word matcher could afford: an alignment of
 * several consecutive words is hard to fool, so looking further ahead recovers
 * from a dropped phrase instead of stalling, without inviting false matches.
 */
const FORWARD = 30
const BACK = 20

/** Words an alignment may step over — a misheard word, or "10:30" in the script. */
const MAX_SKIPS = 2

/**
 * What it takes to move the cursor backwards.
 *
 * Going back is a real thing readers do — flub a line, say it again — but it is
 * also what a revised transcript looks like when it resolves a word or two
 * earlier. Following those made the script rock. A genuine re-read lines up
 * several words well behind where we are, so both a solid alignment and a
 * meaningful distance are required; a revision satisfies neither.
 */
const REREAD_WORDS = 3
const REREAD_DISTANCE = 3

/** Words too weak to establish a position alone, however close. */
const COMMON = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in',
  'is', 'it', 'of', 'on', 'or', 'so', 'that', 'the', 'to', 'was', 'we', 'you',
])

/**
 * Line `phrase` up against the script from `start`, tolerating a few misses on
 * either side, and report how many words matched and where it ended.
 */
function align(script: ScriptWord[], start: number, phrase: string[]) {
  let s = start
  let p = 0
  let matched = 0
  let end = start
  let skips = 0

  while (s < script.length && p < phrase.length && skips <= MAX_SKIPS) {
    if (script[s].key === phrase[p]) {
      matched++
      s++
      p++
      end = s
    } else if (s + 1 < script.length && script[s + 1].key === phrase[p]) {
      s++ // a script word the engine never returns, such as a number
      skips++
    } else if (p + 1 < phrase.length && script[s].key === phrase[p + 1]) {
      p++ // a misheard or dropped word
      skips++
    } else {
      s++
      p++
      skips++
    }
  }

  return { matched, end }
}

/**
 * Advance `cursor` through `script` using what was just said.
 *
 * Rather than committing word by word — where a lone "the" is the only evidence
 * available and the nearest copy wins — every candidate position is scored on
 * how much of the phrase lines up there against how far it is from the current
 * position. Agreement is squared, so a run of four matching words outweighs a
 * closer run of two, while proximity still breaks ties between equally good
 * alignments.
 *
 * This is also what makes re-sent transcripts harmless: the same phrase aligns
 * the same way every time, so hearing it twice changes nothing.
 */
export function advanceCursor(
  script: ScriptWord[],
  cursor: number,
  heard: string[],
): number {
  // Only the tail matters; earlier words have already moved the cursor.
  const phrase = heard.slice(-PHRASE)
  if (phrase.length === 0) return cursor

  let bestEnd = cursor
  let bestStart = cursor
  let bestScore = 0
  let bestMatched = 0

  const from = Math.max(0, cursor - BACK)
  const to = Math.min(script.length, cursor + FORWARD)

  for (let start = from; start < to; start++) {
    if (script[start].key !== phrase[0]) continue

    const { matched, end } = align(script, start, phrase)
    if (matched === 0) continue

    // One word is only evidence where we already expected it, and a common word
    // is not even that.
    if (matched < 2 && (start !== cursor || COMMON.has(phrase[0]))) continue

    const distance = start >= cursor ? start - cursor : (cursor - start) * 2
    const score = (matched * matched) / (1 + distance)

    if (score > bestScore) {
      bestScore = score
      bestEnd = end
      bestStart = start
      bestMatched = matched
    }
  }

  // Only a re-read goes backwards; a revision settling slightly earlier does not.
  if (
    bestEnd < cursor &&
    (bestMatched < REREAD_WORDS || cursor - bestStart < REREAD_DISTANCE)
  ) {
    return cursor
  }

  return bestEnd
}
