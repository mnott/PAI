# Dictation speaker labels (PAI#33)

Goal: label dictated or recorded multi-speaker audio as `Speaker 1: ...`, `Speaker 2: ...`. Local only: audio and text never leave the machine.

## Pipeline
1. whisper.cpp returns `verbose_json` with `segments[]` (`start`, `end`, `text`).
2. Optional diarization with the sherpa-onnx offline speaker diarization CLI (`sherpa-onnx-offline-speaker-diarization`): pyannote segmentation ONNX plus a speaker-embedding ONNX, CPU only, no GPU. Output lines: `0.318 -- 6.865 speaker_00`.
3. Each whisper segment goes to the speaker with maximum time overlap. A segment with no overlap continues the previous speaker. Consecutive same-speaker segments merge.
4. Speakers are numbered `Speaker 1..n` by first appearance, not by the tool's ids.
5. With no turns (tool or models missing, or it failed) the plain text is used unchanged.

## Installation
- The binary is an optional external tool, found on PATH or in `~/.pai/bin`. It is never bundled.
- Models live in `~/.pai/models/diarization` and are never downloaded automatically; the user places them there.
- Availability check (2026-11-27): not installed here; no Homebrew formula `sherpa-onnx`; the `sherpa-onnx` PyPI wheel exists (small, models separate). Nothing was downloaded.

## Code
`apps/menubar/Sources/PAIMenuBarCore/Speakers.swift`: `parseDiarization`, `parseSegments`, `labelSpeakers` (pure). Not wired into the controller yet: next step is running the CLI on the recorded WAV (model flags, optional `--clustering.num-clusters`) and calling `labelSpeakers`.
