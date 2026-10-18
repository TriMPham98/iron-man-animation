"""Build audio/cues.json for the flight-sim reel from the capture's own event log.

The reel is flown by the sim (flight.html?capture, one frame per step); every
frame number here comes from capture/log.json — what actually happened on
that frame of the picture. Nothing is typed in by hand except which sound
each kind of action gets.

    python3 scripts/flight-cues.py            # capture/log.json -> audio/cues.json
"""
import json, os

LOG = 'capture/log.json'
OUT = 'audio/cues.json'
FPS = 30
S = 'public/sounds/'
F = 'public/sounds/flight/'

d = json.load(open(LOG))
log = d['log']
frames = d['frames']
cues = []


def cue(id, frame, sound, weight='support', visual=None, pan=0.0, **kw):
    c = dict(id=id, frame=int(frame), sound=sound, weight=weight, align=kw.pop('align', 'peak'), pan=round(max(-0.6, min(0.6, pan or 0.0)), 2))
    if visual: c['visual'] = visual
    c.update(kw)
    cues.append(c)


def first(kind, text=None):
    for e in log:
        if e['kind'] == kind and (text is None or e.get('text') == text):
            return e
    return None


# Heroes: each a hit + low boom on a picture cut, the music stopped dead
# before it and filtered up into it, a riser peaking on the same frame
HEROES = [
    ('reveal', first('cameraCut', 'reveal'), 'hit/fs-359140-low-metal-hit-2-wav-1+boom/fs-636624-deep-hit-2', 'riser/fs-503801-reverse-fx-3-wav-1'),
    ('boom', first('cameraCut', 'boom'), F + 'sonic-boom.mp3+' + F + 'explosion-sub.mp3', 'riser/fs-503799-reverse-fx-9-wav-1'),
    ('kill', first('cameraCut', 'kill'), F + 'explosion-near.mp3+' + F + 'explosion-sub.mp3', 'riser/fs-396161-scary-hits-risers-001-1'),
    ('salvo', first('cameraCut', 'salvo'), F + 'explosion-huge.mp3+' + F + 'explosion-sub.mp3', None),
    ('unibeam', first('cameraCut', 'unibeam'), F + 'explosion-sub.mp3+' + S + 'repulsor.mp3', F + 'charge.mp3'),
    ('landing', first('cameraCut', 'landed'), 'hit/fs-359141-low-metal-hit-1-wav-1+' + F + 'deep-boom.mp3', 'riser/fs-275512-reversed-riser-wav-1'),
]
hero_frames = []
for name, e, sound, riser in HEROES:
    if not e:
        continue
    hero_frames.append(e['frame'])
    cue(name, e['frame'], sound, 'hero', 'cut', stop_before=True, build=True)
    if riser:
        cue(name + '-rise', e['frame'], riser)


def busy(f, span=12):
    """Another action within ~0.4 s (a UI blip there would only be masked)."""
    return any(abs(e['frame'] - f) <= span for e in log if e['kind'] not in ('jarvis', 'cameraCut', 'repulsorCharge', 'missileDecoyed', 'boostEnd', 'siloClose'))


def near_hero(f, span=4):
    return any(abs(f - h) <= span for h in hero_frames)


# Support: every real action, tagged with what the picture does on that frame
n = {}
def nid(k):
    n[k] = n.get(k, 0) + 1
    return f'{k}{n[k]}'


last_expl = -99
for e in log:
    f, k, pan = e['frame'], e['kind'], e.get('pan', 0.0)
    if k == 'takeoff':
        if not near_hero(f):
            cue('ignite', f, S + 'thruster-ignite.mp3', visual='appear', pan=pan)
        cue('burn', f + 12, S + 'thruster-burn.mp3', align='start', pan=pan)
    elif k == 'boostStart':
        cue('boost', f, F + 'rocket-1.mp3', visual='move', pan=pan)
        cue('air', f, F + 'wind.mp3', align='start')
    elif k == 'cameraCut' and e.get('text') in ('chase', 'landing'):
        cue(nid('cut'), f, 'whoosh/fs-449989-whoosh-long-mid-wav-1', visual='cut')
    elif k == 'jarvis' and e.get('text') and not near_hero(f) and not busy(f):
        cue(nid('jarvis'), f, F + 'jarvis-blip.mp3', visual='appear')
    elif k == 'repulsorFire':
        cue(nid('repulsor'), f, S + 'repulsor.mp3', visual='appear', pan=pan)
    elif k == 'siloOpen':
        cue('silos', f, S + 'weapon-deploy.mp3', visual='appear')
    elif k == 'lockTick':
        cue(nid('lock'), f, F + 'lock-tick.mp3', visual='appear')
    elif k == 'missileLaunch':
        cue(nid('rocket'), f, F + ('rocket-2.mp3' if n.get('rocket', 0) % 2 else 'rocket-1.mp3'), visual='appear', pan=pan)
    elif k == 'enemyMissile':
        blast = next((c for c in cues if c['id'].startswith('blast') and abs(c['frame'] - f) <= 4), None)
        if blast:
            # Two actions on one beat: one layered cue (peaks aligned)
            blast['sound'] += '+' + F + 'sam-launch.mp3'
        else:
            cue('seeker', f, F + 'sam-launch.mp3', visual='appear', pan=pan)
    elif k == 'flarePop':
        cue(nid('flare'), f, F + 'flare-pop.mp3', visual='appear', pan=pan)
    elif k in ('explosion', 'bigExplosion'):
        dist = e.get('dist') or 0
        # Far-off wrecks hitting the ground stay under the score
        if near_hero(f) or f - last_expl < 6 or dist > 2500 or (k == 'bigExplosion' and dist > 950):
            continue
        last_expl = f
        snd = F + ('explosion-huge.mp3' if k == 'bigExplosion' else 'explosion-near.mp3')
        cue(nid('blast'), f, snd, visual='appear', pan=pan, pitch=-2 if dist > 900 else 0)
    elif k == 'unibeamEnd':
        cue('beam-off', f, S + 'steam-release.mp3', visual='appear')

duration = round(frames / FPS, 3)
sheet = {
    'fps': FPS,
    'duration_s': duration,
    'energy': 'punchy',
    'kit': 'audio/kit',
    'music': {'file': 'audio/music/dark-orchestral.mp3', 'start_s': 0, 'loop': True, 'fade_out_s': 2.5},
    'silence_ok': [[round(duration - 0.4, 2), duration]],
    'cues': sorted(cues, key=lambda c: c['frame']),
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(sheet, open(OUT, 'w'), indent=1)
print(len(cues), 'cues,', len(hero_frames), 'heroes at', [round(f / FPS, 2) for f in hero_frames], 's; duration', duration)
