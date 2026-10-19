# Flight sim sound credits

All recordings are CC0 (public domain). Picked with the sound-layer kit
(https://github.com/Bodila51/opus-sound-layer); cut, looped and level-matched by
`scripts/build-flight-sounds.py`. The suit's own sounds (thrusters, servos, repulsor, weapon
deploy) come from the project library in `public/sounds/`.

- `explosion-near.mp3` — "low mid afar explosion 1.wav" by Logicogonist (sound-layer kit id `boom/fs-264031-low-mid-afar-explosion-1-wav-1`, CC0)
- `explosion-sub.mp3` — "Cinematic Trailer Hit Explosion CC0.mp3" by Wakerone (sound-layer kit id `hit/fs-513110-cinematic-trailer-hit-explos-1`, CC0)
- `explosion-huge.mp3` — "Huge Explosion - Thunder - Exploding" by dmstudio (sound-layer kit id `boom/fs-320782-huge-explosion-thunder-explo-3`, CC0)
- `sonic-crack.mp3` — "BACKFIRE.ogg" by CeebFrack (sound-layer kit id `boom/fs-105351-backfire-ogg-1`, CC0)
- `sonic-boom.mp3` — "Deep hit" by CogFireStudios (sound-layer kit id `boom/fs-636624-deep-hit-2`, CC0)
- `hero-thud.mp3` — "Heavy Metal Thud on Ground" by 7of9Designs (sound-layer kit id `hit/fs-640204-heavy-metal-thud-on-ground-1`, CC0)
- `deep-boom.mp3` — "Deep Boom" by Za-Games (sound-layer kit id `boom/fs-539968-deep-boom-3`, CC0)
- `metal-crash.mp3` — "Heavy Metal Impact 2" by magnuswaker (sound-layer kit id `hit/fs-614063-heavy-metal-impact-2-1`, CC0)
- `rocket-1.mp3` — "whoosh_med_low.wav" by DJT4NN3R (sound-layer kit id `whoosh/fs-449995-whoosh-med-low-wav-1`, CC0)
- `rocket-2.mp3` — "whoosh_med_mid.wav" by DJT4NN3R (sound-layer kit id `whoosh/fs-449994-whoosh-med-mid-wav-1`, CC0)
- `flyby.mp3` — "whoosh_long_mid.wav" by DJT4NN3R (sound-layer kit id `whoosh/fs-449989-whoosh-long-mid-wav-1`, CC0)
- `zip.mp3` — "Knife/sword swing" by spycrah (sound-layer kit id `whoosh/fs-471097-knife-sword-swing-1`, CC0)
- `charge.mp3` — "Energy Riser 3" by magnuswaker (sound-layer kit id `riser/fs-531729-energy-riser-3-1`, CC0)
- `repulsor-zap.mp3` — Kenney (kenney.nl), Sci-fi Sounds (sound-layer kit id `zap/kenney-scifi-laser-large-001`, CC0)
- `lock-tick.mp3` — Kenney (kenney.nl), Digital Audio (sound-layer kit id `ui/kenney-digital-three-tone2`, CC0)
- `lock-full.mp3` — Kenney (kenney.nl), Interface Sounds (sound-layer kit id `ui/kenney-interface-confirmation-001`, CC0)
- `warn.mp3` — Kenney (kenney.nl), Digital Audio (sound-layer kit id `ui/kenney-digital-high-down`, CC0)
- `jarvis-blip.mp3` — Kenney (kenney.nl), Digital Audio (sound-layer kit id `ui/kenney-digital-three-tone1`, CC0)
- `wave-tone.mp3` — Kenney (kenney.nl), Digital Audio (sound-layer kit id `ui/kenney-digital-low-three-tone`, CC0)
- `ping-1.mp3` — Kenney (kenney.nl), Impact Sounds (sound-layer kit id `tap/kenney-impact-impact-metal-heavy-000`, CC0)
- `ping-2.mp3` — Kenney (kenney.nl), Impact Sounds (sound-layer kit id `tap/kenney-impact-impact-metal-heavy-001`, CC0)
- `ping-3.mp3` — Kenney (kenney.nl), Impact Sounds (sound-layer kit id `tap/kenney-impact-impact-metal-light-001`, CC0)
- `ping-4.mp3` — Kenney (kenney.nl), Impact Sounds (sound-layer kit id `tap/kenney-impact-impact-metal-light-004`, CC0)
- `flare-pop.mp3` — "Thud 2.wav" by nebulasnails (sound-layer kit id `thump/fs-405537-thud-2-wav-1`, CC0)
- `gun.mp3` — "Machine Guns#1.wav" by ctobin (https://freesound.org/people/ctobin/sounds/436585), CC0
- `splash.mp3` — "Big Splash.wav" by Bird_man (https://freesound.org/people/Bird_man/sounds/316744), CC0
- `splash-big.mp3` — "5 meters dive.wav" by bruno.auzet (https://freesound.org/people/bruno.auzet/sounds/529794), CC0
- `sam-launch.mp3` — "Tomahawk Missile Rocket Launch 2" by qubodup (https://freesound.org/people/qubodup/sounds/162379), CC0
- `jet.mp3` — "Jet Flyby 1" by unfa (https://freesound.org/people/unfa/sounds/168079), CC0
- `wind.mp3` (looped) — "Car Strong Wind Noise.mp3" by FunWithSound (https://freesound.org/people/FunWithSound/sounds/439242), CC0
- `jet-loop.mp3` (looped) — "Jet Flyby 1" by unfa (https://freesound.org/people/unfa/sounds/168079), CC0
- `dirt-hit.mp3` — "Dive into Dirt.wav" by CalGre (https://freesound.org/people/CalGre/sounds/467122), CC0 (sound-layer kit id `glitch/fs-467122-dive-into-dirt-wav-1`)
- `debris-1.mp3`, `debris-2.mp3` — "Gravel Impacts and Falls.wav" by lolamadeus (https://freesound.org/people/lolamadeus/sounds/179341), CC0
- `rock-hit.mp3` — "Stone Impact Rubble Debris 3" by Sheyvan (https://freesound.org/people/Sheyvan/sounds/569499), CC0

## JARVIS voice (`jarvis/*.mp3`, `jarvis/manifest.json`)

JARVIS's lines are synthetic speech. They are **not** a clone or imitation of any actor (no Paul Bettany voice model, no film audio).

- Engine: [Piper](https://github.com/OHF-Voice/piper1-gpl) (`piper-tts`, open-source neural TTS, run offline). Rendered by `scripts/render-jarvis-voice.py`, then processed with ffmpeg (EQ, short room, faint exciter "sheen", loudness-matched).
- Voice: `en_GB-vctk-medium` from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_GB/vctk/medium), speaker **p226** (a southern-English male from the corpus).
- Training data: CSTR VCTK Corpus (Yamagishi, Veaux, MacDonald; University of Edinburgh, https://datashare.ed.ac.uk/handle/10283/3443), licensed **CC BY 4.0**. Attribution: "CSTR VCTK Corpus: English Multi-speaker Corpus for CSTR Voice Cloning Toolkit (version 0.92)", University of Edinburgh, Centre for Speech Technology Research.
- Caveat: like every Piper `medium` en_GB voice, this model was fine-tuned from the en_US `lessac` checkpoint, whose dataset (Blizzard 2013 Lessac) carries its own research-use licence. That's fine for this private, non-commercial project. Check it before any commercial release.
