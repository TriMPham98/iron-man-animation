"""Build public/sounds/flight/ from the sound-layer kit and CC0 field recordings.

Every file is a real recording (CC0): picked by eye from its waveform and
spectrogram (sound-layer `sfx.py browse` / `sheet`), then only cut, faded,
looped and level-matched here. Run from the repo root after
`uv run sound-layer/scripts/sfx.py kit` and the searches listed below:

    python3 scripts/build-flight-sounds.py
"""
import json, os, subprocess

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
    'lock-tick': 'ui/kenney-digital-three-tone2',
    'lock-full': 'ui/kenney-interface-confirmation-001',
    'warn': 'ui/kenney-digital-high-down',
    'jarvis-blip': 'ui/kenney-digital-three-tone1',
    'wave-tone': 'ui/kenney-digital-low-three-tone',
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
    # A real double boom off the ground (bow and tail shock ~0.11 s apart),
    # with its own chain: the DC of the recorder's flat pressure step
    # high-passed out, the body lifted and the two cracks pushed up against
    # a limiter so they hit like a slammed door
    'sonic-nwave': ('boom/_raw/ov-3da9f151.mp3', 43.38, 1.8,
                    'highpass=f=22:poles=2,afade=t=in:d=0.004,afade=t=out:st=0.5:d=1.2,bass=g=6:f=80:w=0.8,'
                    'acompressor=threshold=-14dB:ratio=2:attack=0.5:release=120,alimiter=limit=0.7:attack=1:release=40:level=false'),
}
# Loops: (source, start, length, crossfade)
LOOPS = {
    'wind': ('transition/_raw/ov-8ba94356.mp3', 30.0, 22.0, 2.0),
    'jet-loop': ('transition/_raw/ov-7de6124e.mp3', 33.0, 5.0, 1.2),
}


def run(args):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *args], check=True)


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
