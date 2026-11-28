# Hotkey dictation (menu bar app)

First slice. The PAI menu bar app records on a global hotkey, sends the audio to a
whisper.cpp `whisper-server` and pastes the text into the frontmost app. Cloud-free,
local only. The app is a client: it never starts a server and never downloads models.

## Architecture

- `PAIMenuBarCore/Dictation.swift` (pure): model catalog, `DictationSettings`
  (`~/.pai/dictation.json`), multipart request builder, WAV writer, response parser
  with the same filler filter as AIBroker `core/stt.ts` (`isHallucination`).
- `PAIMenuBar/Dictation.swift`: `DictationController` (hotkey via Carbon
  `RegisterEventHotKey`, `AVAudioEngine` converted to 16 kHz mono Int16, POST to
  `{serverURL}/inference` with `file`, `response_format=json`, `language`, paste via
  pasteboard save, Cmd+V `CGEvent`, restore) and the Settings section.
- Status (idle / recording / transcribing / error) prefixes the menu bar title
  (`●` recording, `…` transcribing) and is shown in Settings.
- Server: the persistent AIBroker `whisper-server` (default `http://127.0.0.1:8178`).
  The server loads one model at start; the picker records the wanted model, the
  server must be (re)started with that file.

## Model choice

Catalog: `large-v3-turbo-q5_0` (default, 574 MB), `medium`, `small`, `base`.
Searched in order: `~/.pai/models/whisper/`, `~/.cache/aibroker-stt/`, the VoiceInk dir
(`~/Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels/`).
Chosen at setup (macOS only, step 20: `pai setup --dictation-model ID`, or the menu; `--yes` keeps the
current model or the default; it writes `modelId` and prints the download command when the file is
missing), changed later with `pai setup --dictation-model ID`, in Settings > Dictation or by editing
`~/.pai/dictation.json`.
No auto download; the user runs, e.g.:

    mkdir -p ~/.pai/models/whisper && curl -L -o ~/.pai/models/whisper/ggml-large-v3-turbo-q5_0.bin \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin

(swap the file name for `ggml-small.bin`, `ggml-base.bin`, `ggml-medium.bin`).

Settings keys: `modelId`, `language` (`auto` or ISO), `hotkey` (`keyCode`, Carbon
`modifiers`; default ctrl+opt+space; set with the recorder in Settings), `pushToTalk`, `serverURL`, `speakerLabels`
(placeholder).

## Speaker identification

The label logic (diarization turns plus whisper segments, `Speaker 1..n`) exists as pure code in
`PAIMenuBarCore/Speakers.swift` but is not wired into the controller yet, so `speakerLabels` stays
false and is ignored. Design and install notes: [dictation-speakers.md](dictation-speakers.md).

## VoiceInk replacement checklist

- [x] Global hotkey, toggle and push-to-talk
- [x] Local whisper.cpp model reuse (VoiceInk model dir is searched)
- [x] Paste into frontmost app with pasteboard restore
- [x] Language auto or fixed
- [x] Hotkey recorder UI (with reset)
- [ ] Per-app prompts / vocabulary, text replacements
- [ ] Recording indicator overlay and sounds
- [ ] Server lifecycle (start/stop with model switch) from the app or `pai`
- [x] Setup-flow step that lists models and writes `modelId` (`pai setup --dictation-model`)
- [ ] Speaker labels (core done, not wired in)

## Permissions

- Microphone: `NSMicrophoneUsageDescription` in the generated Info.plist, audio-input
  entitlement for the hardened runtime. First hotkey press triggers the prompt.
- Accessibility (post Cmd+V): prompted via `AXIsProcessTrustedWithOptions`. Without it
  the text is left on the clipboard and the status shows the reason.

## What is left

Everything unchecked above, plus an on-device test of the signed app (hotkey, mic prompt,
paste) which was not done in the headless build.
