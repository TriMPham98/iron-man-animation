#!/usr/bin/env python3
"""
Pre-renders every JARVIS line the flight sim shows into a voiced file.

  python scripts/render-jarvis-voice.py --piper <venv python> --model <en_GB-vctk-medium.onnx>
        [--speaker 95] [--espeak-data <short path to piper's espeak-ng-data>] [--force]

1. Finds the lines in the source (`'jarvis', { text: '…' }`, `engage('…')`, the
   wave table's `line: '…'`).
2. Speaks each with Piper (open-source neural TTS, runs offline), voice
   en_GB-vctk-medium, speaker p226 — a calm southern-English male. NOT a clone
   or imitation of any actor: VCTK is a CC-BY 4.0 research corpus.
3. Gives it the suit-AI character with ffmpeg: rumble/mud cut, a little
   presence and air, a short tight room, a faint high "sheen" (exciter on a
   band-passed copy), level-matched to -18 LUFS and limited.
4. Writes public/sounds/flight/jarvis/<id>.mp3 and manifest.json (id, text, file,
   duration). Unchanged lines are skipped unless --force.

The game looks lines up by normalised text (src/flight/audio/voice/jarvisVoice.ts);
anything missing falls back to the browser's speech synthesis.
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "sounds" / "flight" / "jarvis"

PATTERNS = [
    re.compile(r"""['"]jarvis['"]\s*,\s*\{\s*text:\s*(['"])(.+?)\1"""),
    re.compile(r"""engage\(\s*(?:line\s*=\s*)?(['"])(.+?)\1"""),
    re.compile(r"""\bline:\s*(['"])(.+?)\1"""),
]

# The voice's own read of a few words (spelling only; the text shown is unchanged)
SAY: dict[str, str] = {
    "Rerouting": "Re-routing",
    "Surface-to-air sites are lighting up on the ridgeline. I suggest the flares.": "Surface to air sites are lighting up, on the ridge line. I suggest, the flares.",
}

FILTER = ",".join(
    [
        "highpass=f=85",
        "equalizer=f=220:t=q:w=1.0:g=-2.5",  # less chest boom: tighter, more "comms"
        "equalizer=f=3200:t=q:w=1.2:g=2.0",  # presence
        "highshelf=f=9000:g=2.0",  # air
        "aresample=44100",
        "asplit=2[dry][sh]",
        # Faint digital sheen: an excited, band-limited ghost a hair behind
        "[sh]highpass=f=3500,aexciter=amount=2:drive=7:blend=0:freq=5000:ceil=16000,"
        "adelay=5,volume=0.10[sheen]",
        "[dry][sheen]amix=inputs=2:weights=1 1:normalize=0",
        # Short, tight room (the suit's helmet / the workshop speakers)
        "aecho=0.9:0.6:11|19|31:0.12|0.07|0.04",
        "loudnorm=I=-18:TP=-2:LRA=7",
        "alimiter=limit=0.89",
        "adelay=60",  # a breath before he speaks
        "apad=pad_dur=0.25",
    ]
)


def find_lines() -> list[str]:
    seen: dict[str, None] = {}
    for f in sorted((ROOT / "src").rglob("*.ts")):
        if f.name.endswith(".test.ts"):
            continue
        src = f.read_text()
        for pat in PATTERNS:
            if pat.pattern.startswith(r"\bline") and "jarvis" not in src:
                continue
            for m in pat.finditer(src):
                text = m.group(2).replace("\\'", "'")
                seen.setdefault(text, None)
    return list(seen)


def normalise(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", text.lower())).strip()


def line_id(text: str) -> str:
    words = normalise(text).split()[:5]
    return "-".join(words) + "-" + hashlib.sha1(normalise(text).encode()).hexdigest()[:6]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--piper", required=True, help="python with piper-tts installed")
    ap.add_argument("--model", required=True)
    ap.add_argument("--speaker", type=int, default=95)  # p226 in en_GB-vctk-medium
    ap.add_argument("--length", type=float, default=1.0)
    ap.add_argument("--noise", type=float, default=0.333)
    ap.add_argument("--noise-w", type=float, default=0.5)
    ap.add_argument("--espeak-data", default="")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT / "manifest.json"
    old = {}
    if manifest_path.exists():
        old = {l["id"]: l for l in json.loads(manifest_path.read_text()).get("lines", [])}

    say_py = (
        "import sys, wave\n"
        "from pathlib import Path\n"
        "from piper import PiperVoice, SynthesisConfig\n"
        "model, spk, length, ns, nw, out, esd, text = sys.argv[1:9]\n"
        "kw = {'espeak_data_dir': Path(esd)} if esd else {}\n"
        "v = PiperVoice.load(model, **kw)\n"
        "c = SynthesisConfig(speaker_id=int(spk), length_scale=float(length), noise_scale=float(ns), noise_w_scale=float(nw))\n"
        "with wave.open(out, 'wb') as w: v.synthesize_wav(text, w, syn_config=c)\n"
    )
    lines = []
    with tempfile.TemporaryDirectory() as tmp:
        say = Path(tmp) / "say.py"
        say.write_text(say_py)
        for text in find_lines():
            lid = line_id(text)
            mp3 = OUT / f"{lid}.mp3"
            if mp3.exists() and lid in old and not a.force:
                lines.append(old[lid])
                print("keep ", lid)
                continue
            spoken = text
            for k, v in SAY.items():
                spoken = spoken.replace(k, v)
            wav = Path(tmp) / f"{lid}.wav"
            subprocess.run([a.piper, "-I", str(say), a.model, str(a.speaker), str(a.length), str(a.noise), str(a.noise_w), str(wav), a.espeak_data, spoken], check=True)
            subprocess.run(
                ["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-filter_complex", FILTER, "-ac", "1", "-c:a", "libmp3lame", "-write_xing", "1", "-q:a", "4", str(mp3)],
                check=True,
            )
            dur = float(
                subprocess.run(
                    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(mp3)],
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout
            )
            lines.append({"id": lid, "text": text, "file": f"{lid}.mp3", "duration": round(dur, 2)})
            print("voice", lid, f"{dur:.2f}s")

    manifest = {
        "voice": {
            "engine": "Piper 1.x (piper-tts, open source)",
            "model": "en_GB-vctk-medium",
            "speaker": f"p226 (id {a.speaker})",
            "license": "VCTK corpus CC-BY 4.0 — see public/sounds/flight/CREDITS.md",
        },
        "lines": lines,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    stale = {p.name for p in OUT.glob("*.mp3")} - {l["file"] for l in lines}
    if stale:
        print("stale files (no longer in the source):", ", ".join(sorted(stale)), file=sys.stderr)
    print(f"{len(lines)} lines -> {manifest_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
