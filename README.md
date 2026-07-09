# Mark Suit — Assembly Sequence

A polished browser demo of an **Iron Man–inspired suit assembly** animation, built with **Three.js**, **GSAP**, and **Vite**.

Armor plates fly in from off-screen, lock onto a core figure, the arc reactor and eye slits ignite, then you can orbit the finished suit and replay the sequence.

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

## Stack

- [Vite](https://vitejs.dev/) + TypeScript
- [three.js](https://threejs.org/) — WebGL scene, materials, bloom
- [GSAP](https://gsap.com/) — assembly timeline and camera path

## Project layout

```
src/
  main.ts                 # bootstrap + render loop
  scene/                  # renderer, camera, lights, env, post-FX
  suit/                   # procedural modular armor
  animation/              # GSAP assembly timeline
  ui/                     # HUD overlay
  utils/                  # colors, scatter helpers
```

## Notes

- Geometry is **procedural** (no external 3D models) so the repo stays small and license-clean.
- Bloom is disabled automatically on software renderers.
- Pixel ratio is clamped for performance on high-DPI displays.
