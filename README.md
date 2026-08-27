# Teleprompter

**https://teleprompter.twm-sandbox.com**

A teleprompter that follows your voice. Two modes — **Edit** and **Play**.
Entering Play starts listening, goes fullscreen, and highlights words as it
hears them, scrolling to keep your place. Leaving Play releases the microphone.

Sign-in is handled by Cloudflare Access; scripts are private to whoever is
signed in.

## Using it

- **Play** starts listening straight away. Read aloud; spoken words dim behind
  you and the script scrolls to keep the current word on the reading line.
- **Tap any word** to move the cursor there — the escape hatch if tracking gets
  lost.
- **↺** returns to the first word, between takes.
- **⇥ sliders** set text size and eye position. Both matter when the phone sits
  behind a camera: the camera covers the lower screen, so the reading line
  usually wants to be high. While the panel is open a marker shows exactly where
  that line falls, for lining up against the lens.
- The screen is held awake while reading — a phone dims on an idle timer, and
  reading aloud looks exactly like idling.

## Architecture

One Cloudflare Worker serves the built app and its API. D1 is only reachable
from a Worker, so something had to sit in the request path; putting it on the
same origin avoids a cross-origin API, which Access turns into opaque CORS
failures.

    Browser ──► Cloudflare Access ──► Worker ──► D1
                                        └─────► static assets

Access gates the hostname, but the Worker verifies the token itself rather than
trusting the edge: the Worker is also reachable on its `workers.dev` URL, which
Access does not cover. Every `/api/*` request establishes identity first, from
the `Cf-Access-Jwt-Assertion` header, checked against the team's public keys and
pinned to this application's audience.

Ownership is enforced in SQL rather than checked afterwards — every statement
carries the caller's email, so asking for someone else's id matches no rows.

## Speech recognition

Uses the native [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition).
No dependencies, no API keys.

- **Chrome only**, desktop and Android. Firefox has no support; Safari is
  partial.
- Recognition is **Google's cloud service**: audio leaves the device and a
  connection is required. Chrome can run on-device, but reports `unavailable`
  for this language on both of the devices this was built against. An offline
  engine (Vosk via WebAssembly) was built and tried; it is in the history if it
  is ever worth revisiting.
- Chrome on Android ends a session after a few seconds of silence even with
  `continuous = true`
  ([chromium#40324711](https://issues.chromium.org/issues/40324711)), so the
  session restarts automatically. Some Android builds chime on each restart.

## How the tracking works

`match.ts` aligns a **phrase** against the script, not a word.

Matching one word at a time gives the cursor a single piece of evidence per
decision, which makes it both jumpy and prone to stalling: a lone "the" is
evidence of nothing in particular, and the nearest copy of it wins. Instead,
every candidate position is scored on how much of the recent phrase lines up
there against how far it is from the current position:

    score = (words aligned)² / (1 + distance)

Squaring agreement means a run of four matching words beats a nearer run of two,
while proximity still settles ties. Alignments may step over a couple of misses,
which covers both a misheard word and script tokens the engine never returns,
like `10:30`.

Because several consecutive words are hard to fool, the forward window can be
wide — thirty words — which is what lets tracking recover from a phrase the
engine dropped instead of sitting still. It also makes re-sent transcripts
idempotent for free: the same phrase aligns the same way every time.

Going **backwards** needs more. A revised transcript settles a word or two
earlier with a weak alignment; a genuine re-read lines up several words starting
well behind. Only the second moves the cursor back, which is why redoing a
flubbed line works but the script does not rock.

## Files

    src/match.ts        script parsing and phrase alignment
    src/useDictation.ts Web Speech API wrapper (restart, utterance stream)
    src/useScripts.ts   the script list and autosave, against the API
    src/useSettings.ts  text size and eye position, remembered
    src/useWakeLock.ts  keeps the screen lit while reading
    src/App.tsx         the two modes, the sidebar, the scrolling stage

    worker/index.ts     serves the app and routes /api/*
    worker/access.ts    Cloudflare Access token verification
    worker/scripts.ts   scripts CRUD, scoped to the signed-in email
    migrations/         D1 schema

## Development

    npm run dev        # http://localhost:5173, UI only — /api/* is not served
    npm run build
    npm run deploy     # build, then wrangler deploy

`npm run dev` runs Vite alone, so the API returns 404 and the script list will
show an error. For anything touching the API, deploy — or run `wrangler dev`,
which serves the Worker and a local D1.

Deploying needs `wrangler` authenticated against the Cloudflare account
(`npx wrangler login`). Schema changes go in `migrations/` and apply with:

    npx wrangler d1 migrations apply teleprompter --remote

Regenerate Worker types after changing `wrangler.jsonc`:

    npm run cf-types
