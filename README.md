# MK III — Assembly Sequence

A polished browser demo of an **Iron Man MK III–inspired suit assembly** animation, built with **Three.js**, **GSAP**, and **Vite**.

Armor plates fly in from off-screen, lock onto a core figure, the arc reactor and eye slots ignite, then you can orbit the finished suit. On replay, JARVIS runs a **wireframe diagnostic** while the camera eases — then the plates explode and the sequence restarts.

## Quick start

```bash
npm install
npm run dev
```

Open the URL Vite prints (default `http://localhost:5173`).

```bash
npm run build    # production bundle → dist/
npm run preview  # serve dist locally
```

## Controls

| Input | Action |
|--------|--------|
| Drag | Orbit camera (also overrides path while assembly plays) |
| Scroll | Zoom |
| `R` or **REPLAY** | Restart the assembly sequence |
| `S` or **SKIP** | Jump to finished suit / systems online |
| Space | Pause / resume (or restart if finished) |
| `M` | Mute / unmute assembly SFX (persisted; cyan toast) |
| `←` / `→` | Scrub progress (−/+0.2%; Shift = 1%) |
| **DIR** | Toggle director mode (scrubber + plate pick) |

### Director mode

Author tools are **off by default** for a clean portfolio surface.

| Enable | How |
|--------|-----|
| HUD | Click **DIR** in the top-right (preference saved in `localStorage`) |
| URL | `?debug=1` or `?director=1` |
| Force viewer | `?debug=0` |

In director mode you also get:

- Active plate readout (**MOVING**)
- Click a plate to highlight and inspect it
- **RECLASS** panel (top-right): queue mis-tagged plates → **COPY** a pasteable card for chat
- **AUDIO** timeline (bottom): scrub assembly time, pause, drag SFX, crop clips, **COPY** a pasteable cue card
  - **SNAP** — clip edges stick to ruler ticks, the playhead, and other clips; hold `Alt` while dragging to place freely
  - **UNDO** / **REDO** (`⌘Z` / `⇧⌘Z`, `Ctrl` on Windows) — covers moves, crops, gain, deletes and CLEAR
  - Edits made while the sequence is playing re-arm the transport immediately, so you can tune against what you hear

### Reclass card workflow

1. Enable **DIR** mode — the **RECLASS** chip sits top-right (collapsed by default)
2. Click the chip (or header) to expand; picking a plate also expands it
3. Choose **TO** wave (or `[` / `]` to cycle)
4. Optional note → **ADD** (or `A`)
5. Repeat for more plates → **COPY**
6. Paste the card in chat so wave gates can be updated
7. Click the header again to minimize back to a chip

**M** mutes / unmutes assembly SFX (persisted; cyan toast confirms).

### JARVIS briefing (top-bar center)

JARVIS **is** the assembly loading UI — it replaces the old title / status / integrity strip in the top bar center:

- Status line + integrity bar + wave pipeline + ARC / HUD / REP lamps
- Appears when the sequence starts; shows **SYSTEMS ONLINE** once, then **auto-dismisses** so the showcase is just brand + clock
- Reappears on replay (`R`); brief corner flash on online

Decorative motion respects reduced-motion preferences.

### Diagnostic scan (showcase orbit ease-out)

During the finished-suit idle 360°, when the orbit **starts to slow** (`SPIN_EASE_OUT_RAD` window):

1. Wireframe diagnostic runs **head → feet** on the solid suit (end-of-assembly close-out)  
2. Status: `STRUCTURAL` → `POWER GRID` → `SYSTEMS` → `DIAGNOSTIC COMPLETE // NOMINAL`  
3. Scan finishes with the ease; camera seals on hero framing → reverse explode + hangar pull to open-wide → next assembly (seamless loop)  

Silent (no dedicated SFX). Skipped under reduced motion / free-look cancel / `R` before ease-out.

### Accessibility

- `prefers-reduced-motion: reduce` skips the plate cascade and lands on the finished suit with systems online.
- Status and integrity use live regions; canvas has an accessible label.
- Scanline overlay and JARVIS decorative loops are disabled under reduced motion.

## Stack

- [Vite](https://vitejs.dev/) + TypeScript
- [three.js](https://threejs.org/) — WebGL scene, glTF loader, bloom
- [GSAP](https://gsap.com/) — assembly timeline and camera path
- Free textured **Iron Man GLB** (see `public/models/ATTRIBUTION.md`)

## Project layout

```
public/models/ironman.glb # free community suit mesh + textures
public/draco/             # local Draco wasm/js decoders for GLTFLoader
src/
  main.ts                 # bootstrap + render loop
  session/                # assembly session state machine
  scene/                  # renderer, camera, lights, env, post-FX
  suit/                   # glTF load, spatial mesh split, assembly pieces
    waves.ts              # PieceWave types + WAVE_ORDER / WAVE_STATUS
    classifyWave.ts       # pure body-region classification (unit tested)
  animation/              # GSAP assembly timeline
  audio/                  # SFX catalog, engine, timeline model
  ui/                     # HUD, director tools, audio timeline panel
  utils/                  # colors, scatter helpers
public/sounds/            # assembly SFX library (.mp3)
```

```bash
npm test                 # unit tests (assembly order, classifyWave, seeds)
```

## Performance

Single full-fidelity path: shard grid 3×7×3, max DPR 1.75, full-res bloom. Bloom is still disabled automatically on software renderers (SwiftShader / llvmpipe).

Draco mesh decoders are served locally from `public/draco/` (no gstatic CDN).

## Notes

- The suit mesh is a **free fan-art GLB** loaded at runtime, then split into spatial shards for the fly-in assembly sequence.
- Pixel ratio is clamped to 1.75 on high-DPI displays.
- See `public/models/ATTRIBUTION.md` for model credit and IP notes.
