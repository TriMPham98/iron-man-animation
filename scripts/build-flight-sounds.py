"""Build public/sounds/flight/ from the sound-layer kit and CC0 field recordings.

Every file is a real recording (CC0): picked by eye from its waveform and
spectrogram (sound-layer `sfx.py browse` / `sheet`), then only cut, faded,
looped and level-matched here. Run from the repo root after
`uv run sound-layer/scripts/sfx.py kit` and the searches listed below:

    python3 scripts/build-flight-sounds.py
"""
import json, os, re, subprocess

KIT = 'audio/kit'
CAND = 'audio/candidates'
OUT = 'public/sounds/flight'

# name: (source, trim start, trim length or None)
FROM_KIT = {
    'explosion-near': 'boom/fs-264031-low-mid-afar-explosion-1-wav-1',
    'explosion-sub': 'hit/fs-513110-cinematic-trailer-hit-explos-1',
    'explosion-huge': 'boom/fs-320782-huge-explosion-thunder-explo-3',
    'hero-thud': 'hit/fs-640204-heavy-metal-thud-on-ground-1',
    'deep-boom': 'boom/fs-539968-deep-boom-3',
    'rocket-1': 'whoosh/fs-449995-whoosh-med-low-wav-1',
    'rocket-2': 'whoosh/fs-449994-whoosh-med-mid-wav-1',
    'flyby': 'whoosh/fs-449989-whoosh-long-mid-wav-1',
    'zip': 'whoosh/fs-471097-knife-sword-swing-1',
    'charge': 'riser/fs-531729-energy-riser-3-1',
    'repulsor-zap': 'zap/kenney-scifi-laser-large-001',
    'ping-1': 'tap/kenney-impact-impact-metal-heavy-000',
    'ping-2': 'tap/kenney-impact-impact-metal-heavy-001',
    'ping-3': 'tap/kenney-impact-impact-metal-light-001',
    'ping-4': 'tap/kenney-impact-impact-metal-light-004',
    'flare-pop': 'thump/fs-405537-thud-2-wav-1',
}
# Openverse (Freesound CC0) finds from `sfx.py search`: prepared cut or raw
# (source, start, length[, filter chain replacing the default fade + loudnorm])
FROM_SEARCH = {
    'gun': ('hit/ov-b2d50241.wav', 0, None),
    'splash': ('hit/ov-60466366.wav', 0, None),
    'splash-big': ('hit/ov-fce993b0.wav', 0, None),
    'sam-launch': ('whoosh/_raw/ov-86fcafec.mp3', 0.42, 5.2),
    'jet': ('transition/_raw/ov-7de6124e.mp3', 31.0, 8.5),
}
# Cuts from the DCS World sonic boom video (game audio, not CC0: credited by
# hand in CREDITS.md). Fetch its audio first:
#   yt-dlp -x --audio-format wav -o audio/candidates/video/dcs-sonic-boom.wav \
#     https://www.youtube.com/watch?v=vWggV3kWr-w
# name: (start, length, fade-out start, gain dB). Plain gain, no loudnorm:
# the crack must keep its jump over the roar
VIDEO = 'video/dcs-sonic-boom.wav'
FROM_VIDEO = {
    # 1:35 — the crack right on the jet, then the first of its roar
    'sonic-boom-near': (95.93, 3.6, 1.2, -5),
    # 4:05 — far off: the double crack, then the long rolling rumble
    'sonic-boom-far': (246.38, 7.5, 3.0, -5),
}
# HUD tones (Openverse / Freesound CC0, `sfx.py search --type ui`): name:
# (source, start, length). Short clean beeps: peak-normalised, not loudnorm
# (a quarter-second beep has no loudness window to measure)
HUD = {
    # "lock on": the first of its three seeker beeps — one per target painted
    'lock-tick': ('ui/_raw/ov-d46d834b.mp3', 0.0, 0.3),
    # "Missile Lock Detected": one pulse of its warbling RWR beep; the sim
    # retriggers it faster as a seeker closes
    'rwr-pulse': ('ui/_raw/ov-da49f84c.mp3', 0.04, 0.28),
    'kill-confirm': ('ui/_raw/ov-0e4470e4.mp3', 0.0, 0.8),
    'jarvis-blip': ('ui/_raw/ov-72ea12c6.mp3', 0.0, 0.55),
    'wave-start': ('ui/_raw/ov-10a82ee3.mp3', 0.06, 0.95),
    'wave-clear': ('ui/_raw/ov-7c7afab7.mp3', 0.0, 1.0),
}
# Loops: (source, start, length, crossfade)
LOOPS = {
    'wind': ('transition/_raw/ov-8ba94356.mp3', 30.0, 22.0, 2.0),
    'jet-loop': ('transition/_raw/ov-7de6124e.mp3', 33.0, 5.0, 1.2),
    # Wind tearing across a mic: the suit's flared plates shaking in the
    # airstream (the clean middle, before the crackles near the end)
    'buffet': ('transition/_raw/ov-88483e8e.mp3', 4.3, 5.5, 1.0),
    # An AIM-9's seeker growl: the paint searching for heat
    'seeker-growl': ('ui/_raw/ov-6b5a28ab.mp3', 0.5, 4.5, 0.5),
    # "lock on": its solid tone — the house is full, shoot
    'lock-tone': ('ui/_raw/ov-d46d834b.mp3', 1.75, 0.9, 0.2),
}


def run(args):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *args], check=True)


def peak_db(path):
    r = subprocess.run(['ffmpeg', '-v', 'info', '-i', path, '-af', 'volumedetect', '-f', 'null', '-'], capture_output=True, text=True)
    return float(re.search(r'max_volume: (-?[\d.]+) dB', r.stderr).group(1))


def credit_of_search(rel):
    j = os.path.join(CAND, rel.replace('/_raw', '').rsplit('.', 1)[0] + '.json')
    src = json.load(open(j))['source']
    return f"\"{src['title']}\" by {src['creator']} ({src.get('landing') or src['url']}), {src['license'].upper()}"


def main():
    os.makedirs(OUT, exist_ok=True)
    cat = {e['id']: e for e in json.load(open(os.path.join(KIT, 'catalog.json')))['sounds']}
    credits = []
    for name, sid in FROM_KIT.items():
        e = cat[sid]
        run(['-i', os.path.join(KIT, e['file']), '-ar', '44100', '-ac', '1', '-q:a', '3', os.path.join(OUT, name + '.mp3')])
        credits.append(f"- `{name}.mp3` — {e['credit']} (sound-layer kit id `{sid}`, CC0)")
    for name, (rel, start, length, *chain) in FROM_SEARCH.items():
        trim = ['-ss', str(start)] + (['-t', str(length)] if length else [])
        fade = f"afade=t=in:d=0.01,afade=t=out:st={max(0.0, (length or 99) - 0.4)}:d=0.4" if length else 'afade=t=in:d=0.005'
        run([*trim, '-i', os.path.join(CAND, rel), '-af', chain[0] if chain else f'{fade},loudnorm=I=-16:TP=-1.5', '-ar', '44100', '-ac', '1', '-q:a', '3', os.path.join(OUT, name + '.mp3')])
        credits.append(f"- `{name}.mp3` — {credit_of_search(rel)}")
    for name, (rel, start, length) in HUD.items():
        tmp = os.path.join(OUT, f'_{name}.wav')
        run(['-ss', str(start), '-t', str(length), '-i', os.path.join(CAND, rel), '-af',
             f'highpass=f=80,afade=t=in:d=0.004,afade=t=out:st={length - 0.04}:d=0.04', '-ar', '44100', '-ac', '1', tmp])
        run(['-i', tmp, '-af', f'volume={-3 - peak_db(tmp):.1f}dB', '-ar', '44100', '-ac', '1', '-q:a', '3', os.path.join(OUT, name + '.mp3')])
        os.remove(tmp)
        credits.append(f"- `{name}.mp3` — {credit_of_search(rel)}")
    for name, (start, length, fade, gain) in FROM_VIDEO.items():
        run(['-ss', str(start), '-t', str(length), '-i', os.path.join(CAND, VIDEO), '-af',
             f'highpass=f=20,afade=t=in:d=0.004,afade=t=out:st={fade}:d={length - fade},volume={gain}dB',
             '-ar', '44100', '-ac', '1', '-q:a', '3', os.path.join(OUT, name + '.mp3')])
    for name, (rel, start, length, xf) in LOOPS.items():
        # Seamless loop: the tail crossfades into the head
        src = os.path.join(CAND, rel)
        tmp = os.path.join(OUT, f'_{name}.wav')
        # Even out the level first (a pass swells; an engine loop shouldn't)
        run(['-ss', str(start), '-t', str(length + xf), '-i', src, '-af', 'dynaudnorm=f=200:g=21:p=0.9', '-ar', '44100', '-ac', '1', tmp])
        run([
            '-i', tmp, '-filter_complex',
            f"[0]asplit[a][b];[a]atrim=0:{length},asetpts=PTS-STARTPTS[body];"
            f"[b]atrim={length}:{length + xf},asetpts=PTS-STARTPTS[tail];"
            f"[body]atrim=0:{xf},asetpts=PTS-STARTPTS[head];"
            f"[body]atrim={xf},asetpts=PTS-STARTPTS[rest];"
            f"[tail][head]acrossfade=d={xf}:c1=tri:c2=tri[join];"
            f"[join][rest]concat=n=2:v=0:a=1,loudnorm=I=-18:TP=-2[out]",
            '-map', '[out]', '-ar', '44100', '-ac', '1', '-q:a', '3', os.path.join(OUT, name + '.mp3'),
        ])
        os.remove(tmp)
        credits.append(f"- `{name}.mp3` (looped) — {credit_of_search(rel)}")
    # Hand-written sections (## headings) are kept as they are
    path = os.path.join(OUT, 'CREDITS.md')
    kept = ''
    if os.path.exists(path):
        with open(path) as f:
            old = f.read()
        at = old.find('\n## ')
        if at >= 0:
            kept = '\n' + old[at + 1:].rstrip('\n') + '\n'
    with open(path, 'w') as f:
        f.write('# Flight sim sound credits\n\nAll recordings are CC0 (public domain). Picked with the sound-layer kit\n'
                '(https://github.com/Bodila51/opus-sound-layer); cut, looped and level-matched by\n'
                '`scripts/build-flight-sounds.py`. The suit\'s own sounds (thrusters, servos, repulsor, weapon\n'
                'deploy) come from the project library in `public/sounds/`.\n\n' + '\n'.join(credits) + '\n' + kept)
    print(len(credits), 'files')


main()
