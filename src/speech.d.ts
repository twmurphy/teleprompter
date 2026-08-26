/// <reference types="dom-speech-recognition" />

// Chrome 139+ on-device recognition, not yet in @types/dom-speech-recognition.
declare global {
  interface SpeechRecognition {
    /** Require recognition to run on-device: lower latency, audio never leaves the phone. */
    processLocally?: boolean
  }
}

export {}
