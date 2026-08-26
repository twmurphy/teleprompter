# Teleprompter

Two modes — **Edit** and **Play**. Play mode listens to you read and highlights
words as it hears them, keeping the current word in the middle of the screen.

## Running it

Desktop:

    npm run dev          # http://localhost:5173

From your phone, on the same Wi-Fi:

    npm run dev:phone    # https://<your-lan-ip>:5173

The `dev:phone` script exists because the microphone only works in a *secure
context*. `localhost` counts as one; `http://192.168.x.x` does not, so that
script serves over HTTPS with a self-signed certificate. Android Chrome will
show a "Your connection is not private" warning — tap **Advanced → Proceed**.
You only have to do it once per session.

## Speech recognition

Uses the native [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)
(`SpeechRecognition`). No dependencies, no API keys, no audio uploaded by us.

- **Chrome only**, desktop and Android. Firefox has no support; Safari is partial.
- Chrome 139+ *can* run recognition entirely on-device, but you have to
  negotiate it, not just ask. Setting `processLocally = true` without an
  installed language pack makes `start()` fail outright with
  `language-not-supported` — it does not fall back. So `useDictation` calls
  `SpeechRecognition.available()` first and only opts in on `"available"`. If a
  pack is `"downloadable"` it triggers `install()` in the background and uses
  the cloud engine for that session; on-device picks up next time. The status
  line under the script tells you which engine you actually got.
- Chrome on Android ends a recognition session after a few seconds of silence
  even with `continuous = true`
  ([chromium#40324711](https://issues.chromium.org/issues/40324711)), so the
  hook restarts it automatically until you press Stop. On some Android builds
  each restart plays the system listening chime.

## How the highlighting works

`match.ts` never expects a clean transcript. It holds a cursor into the script
and, for each word the engine reports, looks up to 12 words ahead for a loose
match. Words that match nothing are ignored, so background noise and
misrecognitions can't drag your place away. If it does lose you, **tap the word
you're actually on** to move the cursor there.

## Files

    src/match.ts        script parsing + cursor advancement
    src/useDictation.ts Web Speech API wrapper (restart + de-duplication)
    src/App.tsx         the two modes and the scrolling stage

The script is saved to `localStorage` as you type.
