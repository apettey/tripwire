#!/bin/sh
# Regenerates the Kill Reporting sound pack in public/sounds/kill-reporting/.
#
# Runs inside a throwaway Alpine container (installs espeak-ng + ffmpeg); from the repo root:
#   docker run --rm -v "$PWD":/w -w /w alpine:3.20 sh docker/sounds/generate-kill-sounds.sh
# On Windows Git Bash:
#   MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)":/w -w /w alpine:3.20 sh docker/sounds/generate-kill-sounds.sh
#
# Idempotent: every run rebuilds all files from scratch and overwrites them. See docker/sounds/README.md.
set -eu

OUT="${OUT:-public/sounds/kill-reporting}"
RATE=22050          # output sample rate (mono)
BITRATE=48k         # MP3 bitrate
PEAK=-1.5           # voice peak level (dBFS)
TONE_PEAK=-4        # default tone peak (dBFS); steady beeps use lower peaks to match the voices' loudness
COMP="acompressor=threshold=-24dB:ratio=3:attack=5:release=80:makeup=2"

if ! command -v espeak-ng >/dev/null 2>&1 || ! command -v ffmpeg >/dev/null 2>&1; then
    if command -v apk >/dev/null 2>&1; then
        apk add --no-cache espeak-ng ffmpeg >/dev/null
    else
        echo "espeak-ng and ffmpeg are required (run this inside alpine, see header)" >&2
        exit 1
    fi
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

# ---------------------------------------------------------------------------------------------------------------------
# espeak-ng voice variants, written into a private copy of the espeak-ng data. A narrow pitch range
# ("pitch <base> <top>") and flat intonation give the monotone ship-computer delivery; formants stay close
# to the stock voices so the words remain clear.
SYSDATA="$(espeak-ng --version | sed -n 's/.*Data at: *//p')"
mkdir -p "$TMP/espeak"
cp -R "$SYSDATA" "$TMP/espeak/espeak-ng-data"
export ESPEAK_DATA_PATH="$TMP/espeak"
VDIR="$TMP/espeak/espeak-ng-data/voices/!v"

cat > "$VDIR/tw-bot" <<'V'
name tw-bot
language variant
pitch 78 92
intonation 3
V
cat > "$VDIR/tw-deep" <<'V'
name tw-deep
language variant
pitch 52 60
intonation 3
formant 0 96 100 100
formant 1 96 100 100
formant 2 98 100 100
V
cat > "$VDIR/tw-high" <<'V'
name tw-high
language variant
gender female
pitch 175 195
intonation 3
formant 0 108 100 100
formant 1 110 100 100
formant 2 104 100 100
formant 3 106 100 100
V

FF="ffmpeg -hide_banner -loglevel error -nostdin -y"
TRIM="silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse"

# Effect chains (applied after espeak-ng). Kept light on purpose: intelligibility beats effects.
#  bot   : short comb echoes (metallic), light flanger, a touch of bit-crush, presence boost
FX_BOT="aecho=0.9:0.6:9|17:0.30|0.20,flanger=delay=1.5:depth=1.5:speed=0.4:width=60,acrusher=bits=11:mix=0.25:mode=log,highpass=f=120,equalizer=f=2800:t=q:w=1:g=3"
#  deep  : longer comb + chorus, presence boost
FX_DEEP="aecho=0.9:0.6:13|23:0.35|0.22,chorus=0.7:0.9:40|55:0.35|0.3:0.25|0.4:2|2.3,highpass=f=80,equalizer=f=2500:t=q:w=1:g=4"
#  high  : short comb + brighter flanger, slight bit-crush
FX_HIGH="aecho=0.9:0.55:7|13:0.28|0.18,flanger=delay=1:depth=2:speed=0.5:width=60,acrusher=bits=12:mix=0.2:mode=log,highpass=f=160"
#  radio : comms band-pass (350-3200 Hz, 4th order) with mild crush/saturation
FX_RADIO="aecho=0.9:0.6:9|17:0.25|0.15,highpass=f=350,highpass=f=350,lowpass=f=3200,lowpass=f=3200,acrusher=bits=9:mix=0.3:mode=log,equalizer=f=1800:t=q:w=1:g=5"

# speak <out.wav> <variant> <speed wpm> <pitch 0-99> <text>  -> raw espeak-ng speech, silence trimmed
# (text is SSML, so a line can use <break time="..."/> to keep words apart)
speak() {
    espeak-ng -m -v "en-us+$2" -s "$3" -p "$4" -g 2 -w "$TMP/raw.wav" "$5"
    $FF -i "$TMP/raw.wav" -af "$TRIM" -ar "$RATE" -ac 1 "$1"
}

# fx <in.wav> <out.wav> <filter chain>  -> effect chain (with 150 ms of padding for the echo tail)
fx() {
    $FF -i "$1" -af "apad=pad_dur=0.15,$3" -ar "$RATE" -ac 1 "$2"
}

# finish <in.wav> <name> [peak dBFS] [pre-filter]  -> trimmed, faded, peak-normalised MP3 in $OUT
# Voices are compressed first so all lines are similarly loud; every file is then scaled so its peak sits at
# $PEAK dBFS (tones default a bit lower, pure tones sound louder than speech at the same peak).
finish() {
    pre="${4:-anull}"
    $FF -i "$1" -af "$pre,$TRIM,afade=t=in:d=0.005,areverse,afade=t=in:d=0.02,areverse,apad=pad_dur=0.05" -ar "$RATE" -ac 1 "$TMP/pre.wav"
    max="$(ffmpeg -hide_banner -nostdin -i "$TMP/pre.wav" -af volumedetect -f null - 2>&1 | awk '/max_volume:/ { print $(NF-1) }')"
    gain="$(awk -v t="${3:-$PEAK}" -v m="$max" 'BEGIN { printf "%.2f", t - m }')"
    $FF -i "$TMP/pre.wav" -af "volume=${gain}dB" \
        -ac 1 -ar "$RATE" -c:a libmp3lame -b:a "$BITRATE" -map_metadata -1 -id3v2_version 0 -fflags +bitexact \
        "$OUT/$2.mp3"
}
voice() { # voice <in.wav> <name>
    finish "$1" "$2" "$PEAK" "$COMP"
}

# tone <out.wav> <duration s> <aevalsrc expression> [filters]
tone() {
    $FF -f lavfi -i "aevalsrc=exprs='$3':s=$RATE:d=$2" -af "${4:-anull}" -ac 1 "$1"
}

# silence <out.wav> <duration s>
silence() {
    $FF -f lavfi -i "anullsrc=r=$RATE:cl=mono" -t "$2" "$1"
}

# concat <out.wav> <in.wav>...
concat() {
    out="$1"; shift
    : > "$TMP/list.txt"
    for f in "$@"; do echo "file '$f'" >> "$TMP/list.txt"; done
    $FF -f concat -safe 0 -i "$TMP/list.txt" -ar "$RATE" -ac 1 "$out"
}

# Squelch click for the radio variant: short band-passed noise burst (fixed seed, so reproducible)
$FF -f lavfi -i "anoisesrc=d=0.07:c=white:a=0.5:r=$RATE:seed=42" \
    -af "highpass=f=900,lowpass=f=3500,afade=t=in:d=0.003,afade=t=out:st=0.02:d=0.05" -ac 1 "$TMP/squelch.wav"
silence "$TMP/gap.wav" 0.06
# Two alarm beeps (B5) for the alert variant
tone "$TMP/beeps.wav" 0.36 "0.8*sin(2*PI*988*t)*(lt(t,0.14)+between(t,0.22,0.36))" "afade=t=in:d=0.005,lowpass=f=6000"
silence "$TMP/beepgap.wav" 0.15

# ---------------------------------------------------------------------------------------------------------------------
# category | default line | alternative wording
while IFS='|' read -r cat line alt; do
    [ -n "$cat" ] || continue
    echo "voice: $cat"
    # <cat>-bot (default): monotone US male, ship-computer effects
    speak "$TMP/v.wav" tw-bot 145 45 "$line"
    fx "$TMP/v.wav" "$TMP/bot.wav" "$FX_BOT"
    voice "$TMP/bot.wav" "$cat-bot"
    # <cat>-bot-deep: lower and slower
    speak "$TMP/v.wav" tw-deep 130 20 "$line"
    fx "$TMP/v.wav" "$TMP/fx.wav" "$FX_DEEP"
    voice "$TMP/fx.wav" "$cat-bot-deep"
    # <cat>-bot-high: higher, female-ish
    speak "$TMP/v.wav" tw-high 160 60 "$line"
    fx "$TMP/v.wav" "$TMP/fx.wav" "$FX_HIGH"
    voice "$TMP/fx.wav" "$cat-bot-high"
    # <cat>-radio: comms band-pass, squelch click at start and end
    speak "$TMP/v.wav" tw-bot 155 45 "$line"
    fx "$TMP/v.wav" "$TMP/fx.wav" "$FX_RADIO"
    concat "$TMP/radio.wav" "$TMP/squelch.wav" "$TMP/gap.wav" "$TMP/fx.wav" "$TMP/gap.wav" "$TMP/squelch.wav"
    voice "$TMP/radio.wav" "$cat-radio"
    # <cat>-alert: two beeps, then the default bot line
    concat "$TMP/alert.wav" "$TMP/beeps.wav" "$TMP/beepgap.wav" "$TMP/bot.wav"
    voice "$TMP/alert.wav" "$cat-alert"
    # <cat>-alt: alternative wording, default bot voice
    speak "$TMP/v.wav" tw-bot 145 45 "$alt"
    fx "$TMP/v.wav" "$TMP/fx.wav" "$FX_BOT"
    voice "$TMP/fx.wav" "$cat-alt"
done <<'LINES'
neutral|Neutral kill detected.|Kill reported in chain.
gank|Gank detected.|Hostile fleet engagement detected.
kill|Catastrophic Impact detected.|Friendly kill confirmed.
loss|Catastrophic Impact <break time="200ms"/> denial detected.|Friendly loss reported.
LINES

# ---------------------------------------------------------------------------------------------------------------------
# Shared tones (usable for any category)
echo "tones"
# blip: quick upward chirp (900 -> 1740 Hz)
tone "$TMP/t.wav" 0.14 "0.8*sin(2*PI*(900*t+3000*t*t))*(1-t/0.14)" "afade=t=in:d=0.004"
finish "$TMP/t.wav" tone-blip -8
# double beep: two short 1.2 kHz beeps
tone "$TMP/t.wav" 0.31 "0.8*sin(2*PI*1200*t)*(lt(t,0.11)+between(t,0.2,0.31))" "afade=t=in:d=0.004,lowpass=f=7000"
finish "$TMP/t.wav" tone-double-beep -9
# klaxon: 1.5 s, two rising whoops (380 -> 850 Hz) of a buzzy three-harmonic wave
W="(380*mod(t,0.75)+346*mod(t,0.75)*mod(t,0.75))"
tone "$TMP/t.wav" 1.5 "0.5*(sin(2*PI*$W)+0.5*sin(4*PI*$W)+0.3*sin(6*PI*$W))*lt(mod(t,0.75),0.68)" \
    "lowpass=f=3500,acrusher=bits=8:mix=0.2:mode=log,afade=t=in:d=0.01"
finish "$TMP/t.wav" tone-klaxon -9
# sonar: decaying 1.35 kHz ping with two echoes
tone "$TMP/t.wav" 1.6 "0.8*sin(2*PI*1350*t)*exp(-5*t)" "aecho=0.8:0.7:380|760:0.35|0.15,afade=t=in:d=0.004"
finish "$TMP/t.wav" tone-sonar -3
# chime: two rising bell notes (E6, A6) with a soft octave overtone
tone "$TMP/t.wav" 1.2 "0.5*(sin(2*PI*1318.5*t)+0.3*sin(2*PI*2637*t))*exp(-4*t)+0.5*gte(t,0.18)*(sin(2*PI*1760*(t-0.18))+0.3*sin(2*PI*3520*(t-0.18)))*exp(-4*(t-0.18))" \
    "afade=t=in:d=0.004"
finish "$TMP/t.wav" tone-chime "$TONE_PEAK"

echo "done: $(ls "$OUT"/*.mp3 | wc -l) files in $OUT"
