import { useCallback, useEffect, useRef, useState } from 'react'
import type { KaldiRecognizer, Model } from 'vosk-browser'
import { transcriptWords } from './match'
import type { DictationState, Utterance } from './useDictation'

/**
 * Offline recognition with Vosk compiled to WebAssembly.
 *
 * Deliberately the same shape as `useDictation` so the two can be swapped at
 * runtime: both hand back a stream of `Utterance`s and know nothing about the
 * script. Vosk runs its inference inside a Web Worker, so decoding does not
 * compete with the scroll and highlight loops on the main thread.
 *
 * The trade against the cloud engine: no network needed and lower latency,
 * against noticeably lower accuracy and a 39MB model download on first use.
 *
 * vosk-browser inlines its WebAssembly as base64, which is ~6MB of JavaScript.
 * It is therefore imported dynamically, so choosing the cloud engine costs
 * nothing.
 */

const MODEL_URL = '/models/vosk-model-small-en-us-0.15.tar.gz'

/** Chunk size for the audio pump. Smaller means lower latency, more callbacks. */
const BUFFER_SIZE = 4096

// The library and the model are both expensive and safe to share, so they
// outlive any one session and are fetched at most once per page load.
let modelPromise: Promise<Model> | null = null
const loadModel = () =>
  (modelPromise ??= import('vosk-browser').then(({ createModel }) =>
    createModel(MODEL_URL),
  ))

type Options = {
  onUtterance: (utterance: Utterance) => void
}

export function useVosk({ onUtterance }: Options) {
  const [state, setState] = useState<DictationState>('off')
  const [error, setError] = useState<string | null>(null)

  const wantedRef = useRef(false)
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const nodeRef = useRef<ScriptProcessorNode | null>(null)
  const recognizerRef = useRef<KaldiRecognizer | null>(null)
  // Vosk resets its partial transcript after each final result, so a counter is
  // all that is needed to tell one utterance from the next.
  const utteranceRef = useRef(0)

  const onUtteranceRef = useRef(onUtterance)
  onUtteranceRef.current = onUtterance

  const stop = useCallback(() => {
    wantedRef.current = false
    nodeRef.current?.disconnect()
    nodeRef.current = null
    recognizerRef.current?.remove()
    recognizerRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    void contextRef.current?.close()
    contextRef.current = null
    setState('off')
  }, [])

  const start = useCallback(async () => {
    wantedRef.current = true
    setError(null)
    setState('starting')

    try {
      const model = await loadModel()
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
          sampleRate: 16000,
        },
      })
      // The user may have left Play mode while the model was downloading.
      if (!wantedRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream

      const context = new AudioContext()
      contextRef.current = context

      const recognizer = new model.KaldiRecognizer(context.sampleRate)
      recognizerRef.current = recognizer

      recognizer.on('partialresult', (message) => {
        // The payload is a union of partial and final shapes; narrow on the key.
        const partial =
          'result' in message && 'partial' in message.result ? message.result.partial : ''
        if (!partial) return
        onUtteranceRef.current({
          id: `vosk:${utteranceRef.current}`,
          words: transcriptWords(partial),
          isFinal: false,
          text: partial,
        })
      })

      recognizer.on('result', (message) => {
        const text =
          'result' in message && 'text' in message.result ? message.result.text : ''
        if (text) {
          onUtteranceRef.current({
            id: `vosk:${utteranceRef.current}`,
            words: transcriptWords(text),
            isFinal: true,
            text,
          })
        }
        utteranceRef.current += 1
      })

      // ScriptProcessorNode is deprecated in favour of AudioWorklet, but it is
      // the path vosk-browser documents and it works on Android Chrome, which
      // is what matters here.
      const node = context.createScriptProcessor(BUFFER_SIZE, 1, 1)
      node.onaudioprocess = (event) => {
        try {
          recognizer.acceptWaveform(event.inputBuffer)
        } catch {
          // A malformed chunk is not worth ending the session over.
        }
      }
      nodeRef.current = node

      context.createMediaStreamSource(stream).connect(node)
      // Without a destination the processor never runs; a muted gain keeps it
      // pumping without playing the microphone back at the reader.
      const silence = context.createGain()
      silence.gain.value = 0
      node.connect(silence).connect(context.destination)

      setState('listening')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setState('error')
      wantedRef.current = false
    }
  }, [])

  useEffect(() => () => stop(), [stop])

  return { state, error, start, stop }
}
