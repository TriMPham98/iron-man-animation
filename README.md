# Mark Suit — Assembly Sequence

A polished browser demo of an **Iron Man–inspired suit assembly** animation, built with **Three.js**, **GSAP**, and **Vite**.

Armor plates fly in from off-screen, lock onto a core figure, the arc reactor and eye slots ignite, then you can orbit the finished suit and replay the sequence.

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
| Drag | Orbit camera (after assembly completes) |
| Scroll | Zoom |
| `R` or **REPLAY** | Restart the assembly sequence |
| `S` or **SKIP** | Jump to finished suit / systems online |
| Space | Pause / resume (or restart if finished) |
| **DIR** | Toggle director mode (scrubber + plate pick) |

### Director mode

Author tools are **off by default** for a clean portfolio surface.

| Enable | How |
|--------|-----|
| HUD | Click **DIR** in the top-right (preference saved in `localStorage`) |
| URL | `?debug=1` or `?director=1` |
| Force viewer | `?debug=0` |

In director mode you also get:

- Timeline scrubber + pause
- Active plate readout (**MOVING**)
- Click a plate to highlight and inspect it

### Accessibility

- `prefers-reduced-motion: reduce` skips the plate cascade and lands on the finished suit with systems online.
- Status and integrity use live regions; canvas has an accessible label.
- Scanline overlay is disabled under reduced motion.

## Stack

- [Vite](https://vitejs.dev/) + TypeScript
- [three.js](https://threejs.org/) — WebGL scene, glTF loader, bloom
- [GSAP](https://gsap.com/) — assembly timeline and camera path
- Free textured **Iron Man GLB** (see `public/models/ATTRIBUTION.md`)

## Project layout

```
public/models/ironman.glb # free community suit mesh + textures
src/
  main.ts                 # bootstrap + render loop
  scene/                  # renderer, camera, lights, env, post-FX
  suit/                   # glTF load, spatial mesh split, assembly pieces
    waves.ts              # PieceWave types + WAVE_ORDER / WAVE_STATUS
  animation/              # GSAP assembly timeline
  ui/                     # HUD overlay, viewer / director mode
  utils/                  # colors, scatter helpers
```

## Notes

- The suit mesh is a **free fan-art GLB** loaded at runtime, then split into spatial shards for the fly-in assembly sequence.
- Bloom is disabled automatically on software renderers.
- Pixel ratio is clamped for performance on high-DPI displays.
- See `public/models/ATTRIBUTION.md` for model credit and IP notes.
