# MK III — Assembly Sequence

A polished browser demo of an **Iron Man MK III–inspired suit assembly** animation, built with **Three.js**, **GSAP**, and **Vite**.

The GLB is auto-rigged at load and suited up the way Tony does it in the Mark III workshop scene (*Iron Man*, 2008), inside a procedural Malibu workshop. Thirteen industrial arms share the cell — gripper arms carry the 30 suit parts off their cradles and seat them, and two riveter arms punch rivets on the ratchet clicks. The build goes inside → out: boots rise through platform hatches, clamshell fixtures close the shin / thigh / pelvis plates, back plates and abdomen go on, the reactor housing seats before the pecs close over it (the arc reactor catches), pauldrons before the bicep plates, then forearm sleeves, gauntlets, the arms come down and the helmet seats before the faceplate slams shut and the eyes light. Every clamp lands on a measured transient of the director SFX mix; each part locks with a nut runner and sparks before its gripper opens. When an arm has finished its last job it folds and drops into its floor well (or climbs its mast into the ceiling), so the finished suit stands alone. Rivet heads are animation-only and cool away. The armor is cut along the model's own panel lines (hard edges / UV seams), and the helmet only takes head-skinned panels. The workshop monitors carry a live JARVIS feed: the finished suit's wireframe turning under a head-to-feet scan band. On replay, JARVIS runs a **wireframe diagnostic** while the camera eases — then the suit dissolves, every part re-materializes on its cradle and the arms ride back up for the next cycle.

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

### Rig + suit-up choreography

- **Rig** (`src/suit/rig.ts`, `rigPose.ts`) — an 18-bone humanoid skeleton authored from landmarks on the normalized model. Vertices are auto-skinned by capsule distance within their limb (connected islands are classified arm / leg / core first), and islands that sit almost entirely on one bone are snapped rigid so armor plates stay hard and slide at the joints. Poses are scalar channels (`stance`, `chestRecoil`, `headPitch`, `wristL/R`) that are all 0 at the bind pose.
- **Pieces** (`src/suit/armorPieces.ts`) — the skinned mesh is split into 30 film components along the model's own panel lines: each panel (connected run of triangles between its hard edges / UV seams) goes whole to the section that holds most of it; only big smooth shells shared between sections are clipped on section planes (Sutherland–Hodgman, shared seam vertices), so the assembled suit deforms without cracks. Helmet / faceplate only take head-skinned panels. Each piece docks into an anchor bone with `far` (robot-arm carry), `near` (insertion), `hinge` (faceplate) and `twist` (screw-on) channels. The seamless final mesh is the same pieces merged.
- **Robot cell** (`src/workshop/`) — `fittingProgram.ts` places the thirteen arms (grippers and two riveters), assigns every part to a job (clamp / clamshell pair / slide-on / helmet / floor lift) with a rigid grip frame, and parks it on a cradle. Each job is a real cell cycle — transit, hover, descend + grip, carry, straight insertion onto the SFX hit, hold while it locks, open, back off — and no arm is ever double-booked. `robotArm.ts` is a closed-form 6-axis IK (elbow branch per mount, roll-pitch-roll wrist) with procedural geometry and gripper / rivet-gun heads; `robotMaterials.ts` adds clearcoat paint, object-space grime, chipped safety paint and machining scratches; `fittingKinematics.ts` computes part and tool frames on the posed rig, so a held part rides the gripper and the gripper rides a docked part. Unit tests check every hold stays in reach.
- **Choreography** (`src/animation/suitUpChoreography.ts`) — beats are onsets measured inside clips of `choreTimeline.seed.json` (clip start + crop + pitch), so promoting a re-timed mix moves the animation with it. Pose, pieces, systems, hologram, camera and shake are evaluated as a pure function of time; GSAP is only the transport (status lines, spark / steam bursts on live playback).

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
  suit/                   # glTF load, rig + auto-skin, armor cut, effects
    rig.ts                # skeleton landmarks + skin weights (unit tested)
    rigPose.ts            # bones, bind, pose channels
    armorPieces.ts        # film pieces, entry paths, planar cut (unit tested)
    suitEffects.ts        # fitting hologram, rig overlay, hatches, sparks/steam
    waves.ts              # PieceWave types + WAVE_ORDER / WAVE_STATUS
  workshop/               # robot cell: stations + jobs, 6-axis IK arms, environment
  animation/              # SFX-locked choreography, keyframes, GSAP transport
  audio/                  # SFX catalog, engine, timeline model
  ui/                     # HUD, director tools, audio timeline panel
  utils/                  # colors, scatter helpers
public/sounds/            # assembly SFX library (.mp3)
```

```bash
npm test                 # unit tests (rig, armor cut, choreography beats, seeds)
```

## Performance

Single full-fidelity path: 30 skinned pieces sharing one skeleton, static workshop props merged per material (~290 draw calls), max DPR 1.75, full-res bloom. Bloom is still disabled automatically on software renderers (SwiftShader / llvmpipe).

Draco mesh decoders are served locally from `public/draco/` (no gstatic CDN).

## Notes

- The suit mesh is a **free fan-art GLB** loaded at runtime, auto-rigged, and cut into the Mark III suit-up pieces.
- Pixel ratio is clamped to 1.75 on high-DPI displays.
- See `public/models/ATTRIBUTION.md` for model credit and IP notes.
