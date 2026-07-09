import * as THREE from 'three';
import { scatterRotation, scatterStart } from '../utils/easeHelpers';
import * as G from './geometry';
import type { ArmorMaterialKind, SuitMaterials } from './materials';
import { pickMaterial } from './materials';

export type PieceWave =
  | 'boots'
  | 'calves'
  | 'thighs'
  | 'hips'
  | 'torso'
  | 'shoulders'
  | 'arms'
  | 'gauntlets'
  | 'helmet'
  | 'power';

export interface ArmorPiece {
  id: string;
  mesh: THREE.Object3D;
  wave: PieceWave;
  restPosition: THREE.Vector3;
  restRotation: THREE.Euler;
  restScale: THREE.Vector3;
  startPosition: THREE.Vector3;
  startRotation: THREE.Euler;
  startScale: THREE.Vector3;
}

interface PieceDef {
  id: string;
  wave: PieceWave;
  kind: ArmorMaterialKind;
  build: () => THREE.Object3D;
  pos: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number];
}

// ─────────────────────────────────────────────────────────────
// Mark III–inspired modular builders (schematic anatomy)
// Boots + thrusters → shins → thighs/knees → pelvis → abs/chest
// → back flaps → shoulders → arms → gauntlets/repulsors → helm
// → arc reactor
// ─────────────────────────────────────────────────────────────

function buildBoot(mats: SuitMaterials, side: 1 | -1): THREE.Group {
  const g = new THREE.Group();
  // Main foot shell
  const shell = G.box(0.15, 0.1, 0.3, mats.red, 2);
  shell.position.set(0, 0, 0.02);
  g.add(shell);

  // Ankle collar
  const collar = G.cyl(0.075, 0.085, 0.08, mats.red, 20);
  collar.position.set(0, 0.07, -0.04);
  g.add(collar);

  // Gold toe cap (classic Mark III)
  const toe = G.box(0.14, 0.07, 0.1, mats.gold, 2);
  toe.position.set(0, -0.01, 0.16);
  g.add(toe);

  // Side plating
  const sidePlate = G.box(0.04, 0.08, 0.18, mats.redDeep);
  sidePlate.position.set(0.07 * side, 0.01, 0.02);
  g.add(sidePlate);

  // Heel thruster housing
  const thrusterHouse = G.cyl(0.045, 0.05, 0.06, mats.darkMetal, 16);
  thrusterHouse.rotation.x = Math.PI / 2;
  thrusterHouse.position.set(0, -0.02, -0.12);
  g.add(thrusterHouse);

  // Boot thruster disc (repulsor-style)
  const thruster = G.mesh(
    new THREE.CircleGeometry(0.038, 24),
    mats.repulsor,
  );
  thruster.rotation.x = Math.PI / 2;
  thruster.position.set(0, -0.05, -0.12);
  g.add(thruster);

  // Sole plate
  const sole = G.box(0.13, 0.02, 0.26, mats.dark);
  sole.position.set(0, -0.055, 0.02);
  g.add(sole);

  // Rivets
  for (const z of [-0.05, 0.05, 0.12]) {
    const r = G.rivet(mats.goldDeep);
    r.position.set(0.07 * side, 0.04, z);
    g.add(r);
  }

  return g;
}

function buildCalf(mats: SuitMaterials, side: 1 | -1): THREE.Group {
  const g = new THREE.Group();

  // Primary shin armor — tapered cylinder
  const shin = G.cyl(0.095, 0.08, 0.34, mats.red, 28);
  g.add(shin);

  // Anterior gold shin guard (schematic hallmark)
  const guard = G.box(0.07, 0.3, 0.06, mats.gold, 2);
  guard.position.set(0, 0.01, 0.07);
  g.add(guard);

  // Vertical ridge
  const ridge = G.box(0.02, 0.28, 0.02, mats.gold);
  ridge.position.set(0, 0.01, 0.1);
  g.add(ridge);

  // Calf rear shell
  const rear = G.box(0.12, 0.28, 0.06, mats.redDeep);
  rear.position.set(0, 0, -0.06);
  g.add(rear);

  // Side vent slots
  for (let i = 0; i < 3; i++) {
    const vent = G.box(0.03, 0.04, 0.015, mats.dark);
    vent.position.set(0.08 * side, -0.08 + i * 0.08, 0.02);
    g.add(vent);
  }

  // Ankle articulation ring
  const ring = G.torus(0.07, 0.012, mats.darkMetal, 10, 24);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.16;
  g.add(ring);

  return g;
}

function buildThigh(mats: SuitMaterials, side: 1 | -1): THREE.Group {
  const g = new THREE.Group();

  const thigh = G.cyl(0.115, 0.095, 0.36, mats.red, 28);
  g.add(thigh);

  // Outer armor plate
  const outer = G.box(0.06, 0.3, 0.14, mats.redDeep);
  outer.position.set(0.08 * side, 0, 0);
  g.add(outer);

  // Gold knee cap (convex)
  const knee = G.sphere(0.09, mats.gold, 20, 14);
  knee.scale.set(1.15, 0.7, 1.1);
  knee.position.set(0, -0.16, 0.04);
  g.add(knee);

  // Knee under plate
  const kneeUnder = G.box(0.14, 0.06, 0.12, mats.goldDeep);
  kneeUnder.position.set(0, -0.18, 0.02);
  g.add(kneeUnder);

  // Panel grooves
  for (let i = 0; i < 2; i++) {
    const gr = G.groove(0.08, 0.012, mats.dark, 0.09);
    gr.position.set(0, 0.06 - i * 0.1, 0);
    g.add(gr);
  }

  // Hip joint cup
  const cup = G.sphere(0.08, mats.darkMetal, 16, 12);
  cup.scale.set(1, 0.6, 1);
  cup.position.y = 0.16;
  g.add(cup);

  return g;
}

function buildPelvis(mats: SuitMaterials): THREE.Group {
  const g = new THREE.Group();

  // Main pelvic shell
  const shell = G.box(0.46, 0.18, 0.3, mats.red, 2);
  g.add(shell);

  // Gold waist belt
  const belt = G.box(0.48, 0.055, 0.32, mats.gold, 2);
  belt.position.y = 0.08;
  g.add(belt);

  // Belt buckle / center
  const buckle = G.box(0.1, 0.07, 0.06, mats.goldDeep);
  buckle.position.set(0, 0.08, 0.16);
  g.add(buckle);

  // Hip flares
  for (const s of [-1, 1] as const) {
    const flare = G.box(0.1, 0.14, 0.18, mats.redDeep);
    flare.position.set(0.22 * s, -0.02, 0);
    flare.rotation.z = -0.15 * s;
    g.add(flare);
  }

  // Cod / groin plate
  const cod = G.box(0.14, 0.12, 0.12, mats.gold);
  cod.position.set(0, -0.08, 0.1);
  g.add(cod);

  // Lower abs connector
  const connector = G.box(0.2, 0.06, 0.2, mats.darkMetal);
  connector.position.set(0, 0.1, 0);
  g.add(connector);

  return g;
}

function buildAbs(mats: SuitMaterials): THREE.Group {
  const g = new THREE.Group();

  // Tapered abdominal plate stack (3 rows)
  const rows = [
    { y: 0.08, w: 0.34, h: 0.07 },
    { y: 0.0, w: 0.36, h: 0.07 },
    { y: -0.08, w: 0.32, h: 0.07 },
  ];
  for (const row of rows) {
    const plate = G.box(row.w, row.h, 0.22, mats.red, 2);
    plate.position.set(0, row.y, 0.02);
    g.add(plate);
    const seam = G.groove(row.w * 0.85, 0.008, mats.dark, 0.12);
    seam.position.set(0, row.y - row.h * 0.45, 0);
    g.add(seam);
  }

  // Center gold strip
  const center = G.box(0.05, 0.26, 0.04, mats.gold);
  center.position.set(0, 0, 0.13);
  g.add(center);

  // Side ab plates
  for (const s of [-1, 1] as const) {
    const side = G.box(0.08, 0.22, 0.16, mats.redDeep);
    side.position.set(0.18 * s, 0, 0);
    side.rotation.y = -0.2 * s;
    g.add(side);
  }

  return g;
}

function buildChestPlate(mats: SuitMaterials, side: 1 | -1): THREE.Group {
  const g = new THREE.Group();

  // Pectoral plate — slightly convex via sphere + box
  const pec = G.sphere(0.14, mats.red, 24, 18);
  pec.scale.set(1.15, 0.95, 0.75);
  pec.position.set(0, 0.02, 0.02);
  g.add(pec);

  // Outer contour plate
  const outer = G.box(0.14, 0.22, 0.12, mats.redDeep);
  outer.position.set(0.04 * side, 0, -0.02);
  g.add(outer);

  // Collar rise
  const rise = G.box(0.12, 0.08, 0.1, mats.red);
  rise.position.set(0, 0.12, 0.04);
  g.add(rise);

  // Gold edge trim
  const trim = G.box(0.04, 0.2, 0.14, mats.gold);
  trim.position.set(-0.08 * side, 0.02, 0.04);
  g.add(trim);

  // Panel lines
  const line = G.groove(0.1, 0.01, mats.dark, 0.1);
  line.position.set(0, 0.02, 0);
  g.add(line);

  return g;
}

function buildSternum(mats: SuitMaterials): THREE.Group {
  const g = new THREE.Group();

  // Classic gold trapezoid chest center
  const main = G.box(0.12, 0.32, 0.08, mats.gold, 2);
  g.add(main);

  // Upper Y-fork toward collarbones
  for (const s of [-1, 1] as const) {
    const fork = G.box(0.08, 0.06, 0.06, mats.gold);
    fork.position.set(0.06 * s, 0.12, 0.01);
    fork.rotation.z = -0.4 * s;
    g.add(fork);
  }

  // Lower taper
  const lower = G.box(0.08, 0.08, 0.06, mats.goldDeep);
  lower.position.set(0, -0.14, 0);
  g.add(lower);

  // Recess where reactor seats
  const recess = G.cyl(0.085, 0.085, 0.03, mats.darkMetal, 32);
  recess.rotation.x = Math.PI / 2;
  recess.position.set(0, 0.02, 0.05);
  g.add(recess);

  return g;
}

function buildBackPlate(mats: SuitMaterials): THREE.Group {
  const g = new THREE.Group();

  const back = G.box(0.42, 0.44, 0.12, mats.red, 2);
  g.add(back);

  // Spinal gold channel
  const spine = G.box(0.06, 0.4, 0.04, mats.gold);
  spine.position.z = -0.06;
  g.add(spine);

  // Scapular plates
  for (const s of [-1, 1] as const) {
    const scap = G.box(0.14, 0.16, 0.08, mats.redDeep);
    scap.position.set(0.14 * s, 0.1, -0.02);
    g.add(scap);
  }

  // Mark III–style flight stabilizer flaps (folded)
  for (const s of [-1, 1] as const) {
    const flap = G.box(0.12, 0.22, 0.025, mats.red);
    flap.position.set(0.2 * s, 0.02, -0.1);
    flap.rotation.y = 0.35 * s;
    g.add(flap);
    const flapGold = G.box(0.1, 0.04, 0.02, mats.gold);
    flapGold.position.set(0.2 * s, -0.08, -0.1);
    flapGold.rotation.y = 0.35 * s;
    g.add(flapGold);
  }

  // Vent grilles
  for (let i = 0; i < 4; i++) {
    const vent = G.box(0.16, 0.015, 0.02, mats.dark);
    vent.position.set(0, -0.1 + i * 0.05, -0.07);
    g.add(vent);
  }

  return g;
}

function buildCollar(mats: SuitMaterials): THREE.Group {
  const g = new THREE.Group();
  const ring = G.cyl(0.14, 0.16, 0.07, mats.gold, 28);
  g.add(ring);
  const front = G.box(0.22, 0.06, 0.12, mats.goldDeep);
  front.position.set(0, 0, 0.1);
  g.add(front);
  const rear = G.box(0.2, 0.05, 0.08, mats.redDeep);
  rear.position.set(0, 0, -0.1);
  g.add(rear);
  return g;
}

function buildShoulder(mats: SuitMaterials, side: 1 | -1): THREE.Group {
  const g = new THREE.Group();

  // Large pauldron dome
  const dome = G.sphere(0.15, mats.red, 28, 20);
  dome.scale.set(1.25, 0.85, 1.1);
  g.add(dome);

  // Gold top cap
  const cap = G.box(0.24, 0.06, 0.2, mats.gold, 2);
  cap.position.set(0, 0.1, 0);
  g.add(cap);

  // Front / rear ridges
  const front = G.box(0.1, 0.12, 0.16, mats.redDeep);
  front.position.set(0, 0, 0.08);
  g.add(front);

  // Deltoid side plate
  const deltoid = G.box(0.08, 0.14, 0.16, mats.red);
  deltoid.position.set(0.1 * side, -0.04, 0);
  g.add(deltoid);

  // Articulation socket
  const socket = G.sphere(0.07, mats.darkMetal, 16, 12);
  socket.position.set(0.06 * side, -0.08, 0);
  g.add(socket);

  // Missile-pod suggestion (Mark III shoulder detail)
  const pod = G.box(0.08, 0.05, 0.1, mats.darkMetal);
  pod.position.set(0, 0.04, -0.1);
  g.add(pod);

  return g;
}

function buildUpperArm(mats: SuitMaterials, side: 1 | -1): THREE.Group {
  const g = new THREE.Group();

  const arm = G.cyl(0.085, 0.075, 0.3, mats.red, 24);
  g.add(arm);

  // Bicep plate
  const bicep = G.box(0.1, 0.16, 0.12, mats.redDeep);
  bicep.position.set(0.02 * side, 0.04, 0.04);
  g.add(bicep);

  // Gold longitudinal trim
  const trim = G.box(0.03, 0.26, 0.1, mats.gold);
  trim.position.set(0, 0, 0.06);
  g.add(trim);

  // Elbow joint housing
  const elbow = G.sphere(0.07, mats.darkMetal, 16, 12);
  elbow.position.y = -0.14;
  g.add(elbow);

  // Elbow gold cap
  const elbowCap = G.sphere(0.05, mats.gold, 12, 10);
  elbowCap.position.set(0, -0.14, 0.04);
  g.add(elbowCap);

  return g;
}

function buildForearm(mats: SuitMaterials, side: 1 | -1): THREE.Group {
  const g = new THREE.Group();

  const arm = G.cyl(0.075, 0.065, 0.28, mats.red, 24);
  g.add(arm);

  // Classic gold forearm gauntlet plate
  const plate = G.box(0.12, 0.22, 0.08, mats.gold, 2);
  plate.position.set(0, 0, 0.06);
  g.add(plate);

  // Secondary red wrap
  const wrap = G.box(0.1, 0.14, 0.1, mats.redDeep);
  wrap.position.set(0.02 * side, 0.02, -0.04);
  g.add(wrap);

  // Wrist collar
  const wrist = G.cyl(0.06, 0.07, 0.05, mats.goldDeep, 20);
  wrist.position.y = -0.13;
  g.add(wrist);

  // Micro-missile bay suggestion
  const bay = G.box(0.08, 0.1, 0.04, mats.darkMetal);
  bay.position.set(0, 0.02, 0.1);
  g.add(bay);
  for (let i = 0; i < 3; i++) {
    const tube = G.cyl(0.01, 0.01, 0.03, mats.dark, 8);
    tube.rotation.x = Math.PI / 2;
    tube.position.set(-0.02 + i * 0.02, 0.02, 0.12);
    g.add(tube);
  }

  return g;
}

function buildGauntlet(mats: SuitMaterials, _side: 1 | -1): THREE.Group {
  const g = new THREE.Group();

  // Hand back plate
  const back = G.box(0.11, 0.1, 0.14, mats.red, 2);
  g.add(back);

  // Knuckle gold strip
  const knuckles = G.box(0.12, 0.04, 0.1, mats.gold);
  knuckles.position.set(0, -0.05, 0.02);
  g.add(knuckles);

  // Fingers (3-segment stylized)
  const fingerXs = [-0.035, 0, 0.035];
  for (const fx of fingerXs) {
    const f1 = G.box(0.028, 0.05, 0.04, mats.red);
    f1.position.set(fx, -0.09, 0.03);
    g.add(f1);
    const f2 = G.box(0.024, 0.04, 0.035, mats.redDeep);
    f2.position.set(fx, -0.13, 0.035);
    g.add(f2);
  }

  // Thumb
  const thumb = G.box(0.03, 0.05, 0.04, mats.red);
  thumb.position.set(-0.06, -0.06, 0.02);
  thumb.rotation.z = 0.5;
  g.add(thumb);

  // Palm repulsor (Mark III hallmark)
  const palm = G.mesh(new THREE.CircleGeometry(0.04, 24), mats.repulsor);
  palm.rotation.x = -Math.PI / 2;
  palm.position.set(0, -0.02, 0.08);
  g.add(palm);

  const palmRing = G.torus(0.042, 0.006, mats.gold, 8, 24);
  palmRing.rotation.x = Math.PI / 2;
  palmRing.position.set(0, -0.02, 0.08);
  g.add(palmRing);

  // Wrist seal
  const seal = G.cyl(0.055, 0.06, 0.04, mats.darkMetal, 16);
  seal.position.y = 0.06;
  g.add(seal);

  return g;
}

function buildHelmetShell(mats: SuitMaterials): THREE.Group {
  const g = new THREE.Group();

  // Cranial dome — elongated Mark silhouette
  const dome = G.sphere(0.165, mats.red, 40, 28);
  dome.scale.set(1.02, 1.1, 1.12);
  dome.position.y = 0.02;
  g.add(dome);

  // Rear helmet
  const rear = G.sphere(0.14, mats.redDeep, 24, 16);
  rear.scale.set(0.95, 0.9, 0.7);
  rear.position.set(0, 0, -0.06);
  g.add(rear);

  // Gold forehead crest / brow
  const crest = G.box(0.06, 0.05, 0.28, mats.gold, 2);
  crest.position.set(0, 0.12, 0.02);
  g.add(crest);

  // Side cheek armor (red)
  for (const s of [-1, 1] as const) {
    const cheek = G.box(0.06, 0.12, 0.14, mats.red);
    cheek.position.set(0.13 * s, -0.04, 0.04);
    cheek.rotation.y = -0.25 * s;
    g.add(cheek);

    // Cheek vent
    const vent = G.box(0.02, 0.06, 0.04, mats.dark);
    vent.position.set(0.15 * s, -0.04, 0.08);
    g.add(vent);
  }

  // Jaw / mandible
  const jaw = G.box(0.24, 0.09, 0.16, mats.red, 2);
  jaw.position.set(0, -0.12, 0.05);
  g.add(jaw);

  // Chin gold
  const chin = G.box(0.12, 0.05, 0.1, mats.gold);
  chin.position.set(0, -0.16, 0.1);
  g.add(chin);

  // Neck ring
  const neck = G.cyl(0.1, 0.11, 0.05, mats.darkMetal, 20);
  neck.position.y = -0.18;
  g.add(neck);

  // Ear / hinge detail
  for (const s of [-1, 1] as const) {
    const hinge = G.cyl(0.025, 0.025, 0.04, mats.goldDeep, 12);
    hinge.rotation.z = Math.PI / 2;
    hinge.position.set(0.155 * s, 0.02, 0);
    g.add(hinge);
  }

  return g;
}

function buildFaceplate(
  mats: SuitMaterials,
  eyeMeshes: THREE.Mesh[],
): THREE.Group {
  const g = new THREE.Group();

  // Main gold faceplate (slightly curved via scaled sphere front)
  const plate = G.box(0.2, 0.24, 0.07, mats.gold, 2);
  g.add(plate);

  // Brow ridge
  const brow = G.box(0.2, 0.04, 0.05, mats.goldDeep);
  brow.position.set(0, 0.1, 0.02);
  g.add(brow);

  // Nose bridge
  const bridge = G.box(0.04, 0.1, 0.04, mats.goldDeep);
  bridge.position.set(0, 0.02, 0.04);
  g.add(bridge);

  // Classic rectangular eye slits (white-gold emissive)
  for (const s of [-1, 1] as const) {
    const eyeWell = G.box(0.075, 0.032, 0.02, mats.dark);
    eyeWell.position.set(0.052 * s, 0.045, 0.04);
    g.add(eyeWell);

    const eye = G.box(0.068, 0.024, 0.015, mats.eye);
    eye.position.set(0.052 * s, 0.045, 0.048);
    eye.name = s < 0 ? 'eye-L' : 'eye-R';
    g.add(eye);
    eyeMeshes.push(eye);

    // Eye outer gold frame
    const frame = G.box(0.08, 0.036, 0.01, mats.gold);
    frame.position.set(0.052 * s, 0.045, 0.035);
    g.add(frame);
  }

  // Mouth slit / cheek vents
  const mouth = G.box(0.1, 0.012, 0.02, mats.dark);
  mouth.position.set(0, -0.06, 0.04);
  g.add(mouth);

  for (const s of [-1, 1] as const) {
    const cheekLine = G.box(0.03, 0.08, 0.015, mats.dark);
    cheekLine.position.set(0.08 * s, -0.02, 0.04);
    cheekLine.rotation.z = 0.3 * s;
    g.add(cheekLine);
  }

  // Chin point
  const chin = G.box(0.1, 0.04, 0.05, mats.gold);
  chin.position.set(0, -0.12, 0.02);
  g.add(chin);

  return g;
}

function buildReactor(
  mats: SuitMaterials,
  reactorGroup: THREE.Group,
): THREE.Group {
  const g = reactorGroup;

  // Outer housing ring (gold)
  const housing = G.cyl(0.09, 0.09, 0.04, mats.gold, 40);
  housing.rotation.x = Math.PI / 2;
  g.add(housing);

  // Dark inner bezel
  const bezel = G.cyl(0.075, 0.075, 0.03, mats.darkMetal, 40);
  bezel.rotation.x = Math.PI / 2;
  bezel.position.z = 0.01;
  g.add(bezel);

  // Glowing torus rings
  const ringOuter = G.torus(0.062, 0.01, mats.reactorRing, 12, 48);
  ringOuter.position.z = 0.02;
  g.add(ringOuter);

  const ringInner = G.torus(0.04, 0.008, mats.reactorRing, 10, 40);
  ringInner.position.z = 0.025;
  g.add(ringInner);

  // Core sphere
  const core = G.sphere(0.038, mats.reactorCore, 24, 18);
  core.position.z = 0.02;
  g.add(core);

  // Glow disc
  const glow = G.mesh(
    new THREE.CircleGeometry(0.07, 32),
    mats.reactorGlow,
  );
  glow.position.z = 0.03;
  g.add(glow);

  // Triangle / segment accents (stylized RT core)
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const seg = G.box(0.012, 0.03, 0.008, mats.goldDeep);
    seg.position.set(Math.cos(angle) * 0.052, Math.sin(angle) * 0.052, 0.035);
    seg.rotation.z = angle;
    g.add(seg);
  }

  return g;
}

export function createArmorPieces(mats: SuitMaterials): {
  pieces: ArmorPiece[];
  reactorGroup: THREE.Group;
  eyeMeshes: THREE.Mesh[];
} {
  const eyeMeshes: THREE.Mesh[] = [];
  const reactorGroup = new THREE.Group();
  reactorGroup.name = 'reactor';

  const defs: PieceDef[] = [
    // Boots
    {
      id: 'boot-L',
      wave: 'boots',
      kind: 'red',
      pos: [-0.125, 0.055, 0.05],
      build: () => buildBoot(mats, -1),
    },
    {
      id: 'boot-R',
      wave: 'boots',
      kind: 'red',
      pos: [0.125, 0.055, 0.05],
      build: () => buildBoot(mats, 1),
    },
    // Calves / shins
    {
      id: 'calf-L',
      wave: 'calves',
      kind: 'red',
      pos: [-0.125, 0.28, 0],
      build: () => buildCalf(mats, -1),
    },
    {
      id: 'calf-R',
      wave: 'calves',
      kind: 'red',
      pos: [0.125, 0.28, 0],
      build: () => buildCalf(mats, 1),
    },
    // Thighs + knees
    {
      id: 'thigh-L',
      wave: 'thighs',
      kind: 'red',
      pos: [-0.13, 0.58, 0],
      build: () => buildThigh(mats, -1),
    },
    {
      id: 'thigh-R',
      wave: 'thighs',
      kind: 'red',
      pos: [0.13, 0.58, 0],
      build: () => buildThigh(mats, 1),
    },
    // Hips
    {
      id: 'pelvis',
      wave: 'hips',
      kind: 'red',
      pos: [0, 0.88, 0],
      build: () => buildPelvis(mats),
    },
    // Torso stack
    {
      id: 'abs',
      wave: 'torso',
      kind: 'red',
      pos: [0, 1.06, 0.02],
      build: () => buildAbs(mats),
    },
    {
      id: 'chest-L',
      wave: 'torso',
      kind: 'red',
      pos: [-0.13, 1.3, 0.06],
      rot: [0, 0.18, -0.1],
      build: () => buildChestPlate(mats, -1),
    },
    {
      id: 'chest-R',
      wave: 'torso',
      kind: 'red',
      pos: [0.13, 1.3, 0.06],
      rot: [0, -0.18, 0.1],
      build: () => buildChestPlate(mats, 1),
    },
    {
      id: 'sternum',
      wave: 'torso',
      kind: 'gold',
      pos: [0, 1.28, 0.16],
      build: () => buildSternum(mats),
    },
    {
      id: 'back-plate',
      wave: 'torso',
      kind: 'red',
      pos: [0, 1.24, -0.15],
      build: () => buildBackPlate(mats),
    },
    {
      id: 'collar',
      wave: 'torso',
      kind: 'gold',
      pos: [0, 1.5, 0.01],
      build: () => buildCollar(mats),
    },
    // Shoulders
    {
      id: 'shoulder-L',
      wave: 'shoulders',
      kind: 'red',
      pos: [-0.4, 1.44, 0],
      rot: [0, 0, 0.28],
      build: () => buildShoulder(mats, -1),
    },
    {
      id: 'shoulder-R',
      wave: 'shoulders',
      kind: 'red',
      pos: [0.4, 1.44, 0],
      rot: [0, 0, -0.28],
      build: () => buildShoulder(mats, 1),
    },
    // Arms
    {
      id: 'upper-arm-L',
      wave: 'arms',
      kind: 'red',
      pos: [-0.46, 1.18, 0],
      rot: [0, 0, 0.18],
      build: () => buildUpperArm(mats, -1),
    },
    {
      id: 'upper-arm-R',
      wave: 'arms',
      kind: 'red',
      pos: [0.46, 1.18, 0],
      rot: [0, 0, -0.18],
      build: () => buildUpperArm(mats, 1),
    },
    {
      id: 'forearm-L',
      wave: 'arms',
      kind: 'red',
      pos: [-0.58, 0.9, 0.03],
      rot: [0.12, 0, 0.12],
      build: () => buildForearm(mats, -1),
    },
    {
      id: 'forearm-R',
      wave: 'arms',
      kind: 'red',
      pos: [0.58, 0.9, 0.03],
      rot: [0.12, 0, -0.12],
      build: () => buildForearm(mats, 1),
    },
    // Gauntlets
    {
      id: 'gauntlet-L',
      wave: 'gauntlets',
      kind: 'gold',
      pos: [-0.62, 0.68, 0.05],
      rot: [0.15, 0, 0.1],
      build: () => buildGauntlet(mats, -1),
    },
    {
      id: 'gauntlet-R',
      wave: 'gauntlets',
      kind: 'gold',
      pos: [0.62, 0.68, 0.05],
      rot: [0.15, 0, -0.1],
      build: () => buildGauntlet(mats, 1),
    },
    // Helmet
    {
      id: 'helmet-shell',
      wave: 'helmet',
      kind: 'red',
      pos: [0, 1.73, 0],
      build: () => buildHelmetShell(mats),
    },
    {
      id: 'faceplate',
      wave: 'helmet',
      kind: 'gold',
      pos: [0, 1.71, 0.13],
      build: () => buildFaceplate(mats, eyeMeshes),
    },
    // Arc reactor
    {
      id: 'reactor',
      wave: 'power',
      kind: 'gold',
      pos: [0, 1.28, 0.24],
      build: () => buildReactor(mats, reactorGroup),
    },
  ];

  const pieces: ArmorPiece[] = defs.map((def) => {
    const mesh = def.build();
    mesh.name = def.id;

    mesh.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const m = child as THREE.Mesh;
        if (!m.material) {
          m.material = pickMaterial(mats, def.kind);
        }
      }
    });

    const restPosition = new THREE.Vector3(...def.pos);
    const restRotation = new THREE.Euler(...(def.rot ?? [0, 0, 0]));
    const restScale = new THREE.Vector3(...(def.scale ?? [1, 1, 1]));

    const startPosition = scatterStart(restPosition, def.id);
    const startRotation = scatterRotation(def.id);
    const startScale = new THREE.Vector3(0.12, 0.12, 0.12);

    mesh.position.copy(startPosition);
    mesh.rotation.copy(startRotation);
    mesh.scale.copy(startScale);
    mesh.visible = false;

    return {
      id: def.id,
      mesh,
      wave: def.wave,
      restPosition,
      restRotation,
      restScale,
      startPosition,
      startRotation,
      startScale,
    };
  });

  return { pieces, reactorGroup, eyeMeshes };
}

/**
 * Mark III–style suit-up (Iron Man 2008): workshop clamp order, bottom → top.
 * Boots/legs first, then hips → torso → shoulders → arms → gauntlets → helmet,
 * systems/power last (faceplate slam + reactor online beat).
 */
export const WAVE_ORDER: PieceWave[] = [
  'boots',
  'calves',
  'thighs',
  'hips',
  'torso',
  'shoulders',
  'arms',
  'gauntlets',
  'helmet',
  'power',
];

export const WAVE_STATUS: Record<PieceWave, string> = {
  boots: 'DEPLOYING FOOT UNITS…',
  calves: 'LOCKING LOWER LEG PLATES…',
  thighs: 'SECURING FEMORAL ARMOR…',
  hips: 'WAIST MODULE ENGAGED…',
  torso: 'CHEST PLATES ALIGNING…',
  shoulders: 'SHOULDER PODS ATTACHING…',
  arms: 'ARM SERVOS CALIBRATING…',
  gauntlets: 'GAUNTLETS CLAMPING…',
  helmet: 'HELMET SEALING…',
  power: 'SYSTEMS ONLINE — ARC STABLE…',
};
