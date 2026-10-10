# Kill Reporting sound pack

`generate-kill-sounds.sh` builds the sounds in `public/sounds/kill-reporting/` that Kill Reporting plays when a
kill happens in a chain system. The MP3s are committed; you only need the script to change or rebuild them.

## Regenerate

From the repo root (it installs `espeak-ng` and `ffmpeg` inside a throwaway Alpine container):

```bash
docker run --rm -v "$PWD":/w -w /w alpine:3.20 sh docker/sounds/generate-kill-sounds.sh
# Windows Git Bash:
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)":/w -w /w alpine:3.20 sh docker/sounds/generate-kill-sounds.sh
```

The script overwrites every file each run, and with the same image versions the output is byte-identical.
Set `OUT=<dir>` to write somewhere else.

## Files

The client depends on these names (`app/js/fork/kill-reporting.js`). Per category `neutral`, `gank`, `kill`, `loss`:

| File | Sound |
|---|---|
| `<c>-bot.mp3` | Default: monotone ship-computer voice saying the category's line |
| `<c>-bot-deep.mp3` | Same line, deeper and slower |
| `<c>-bot-high.mp3` | Same line, higher (female-ish) |
| `<c>-radio.mp3` | Same line through a comms band-pass, squelch click at start and end |
| `<c>-alert.mp3` | Two alarm beeps, then the default line |
| `<c>-alt.mp3` | Alternative wording in the default voice |

Lines: neutral "Neutral kill detected" / "Kill reported in chain"; gank "Gank detected" / "Hostile fleet
engagement detected"; kill "Catastrophic Impact detected" / "Friendly kill confirmed"; loss "Catastrophic Impact,
denial detected" / "Friendly loss reported".

Shared tones: `tone-blip`, `tone-double-beep`, `tone-klaxon`, `tone-sonar`, `tone-chime`.

All files are mono 22.05 kHz MP3 at 48 kbit/s, under 4 s and 25 KB each, with silence trimmed. Voices are
compressed and peak-normalised to -1.5 dBFS; tones get lower peaks so they sound about as loud as the voices.

## Changing a sound

Edit the line table, the espeak-ng voice variants (`tw-bot`, `tw-deep`, `tw-high`) or the `FX_*` ffmpeg
filter chains in the script, rerun it, and listen to the result. Keep the words easy to understand; the
effects are deliberately light. Lines are SSML, so `<break time="200ms"/>` can separate words that run together.

## Licence

Everything is synthesised by the script: speech by espeak-ng (GPL-3.0 program; its audio output is not covered
by the GPL) and tones by ffmpeg's signal generators. No third-party recordings or samples are used.
