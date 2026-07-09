import * as THREE from 'three';
import { scatterRotation, scatterStart } from '../utils/easeHelpers';
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

function box(
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
}

function cyl(
  rt: number,
  rb: number,
  h: number,
  mat: THREE.Material,
  segs = 16,
): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, segs), mat);
}

function sphere(r: number, mat: THREE.Material, ws = 16, hs = 12): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(r, ws, hs), mat);
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
    // —— Boots ——
    {
      id: 'boot-L',
      wave: 'boots',
      kind: 'red',
      pos: [-0.12, 0.06, 0.06],
      build: () => {
        const g = new THREE.Group();
        g.add(box(0.16, 0.1, 0.28, mats.red));
        const toe = box(0.14, 0.06, 0.1, mats.gold);
        toe.position.set(0, -0.01, 0.14);
        g.add(toe);
        return g;
      },
    },
    {
      id: 'boot-R',
      wave: 'boots',
      kind: 'red',
      pos: [0.12, 0.06, 0.06],
      build: () => {
        const g = new THREE.Group();
        g.add(box(0.16, 0.1, 0.28, mats.red));
        const toe = box(0.14, 0.06, 0.1, mats.gold);
        toe.position.set(0, -0.01, 0.14);
        g.add(toe);
        return g;
      },
    },
    // —— Calves ——
    {
      id: 'calf-L',
      wave: 'calves',
      kind: 'red',
      pos: [-0.12, 0.28, 0],
      build: () => {
        const g = new THREE.Group();
        g.add(cyl(0.1, 0.09, 0.32, mats.red));
        const strip = box(0.04, 0.28, 0.12, mats.gold);
        strip.position.set(0, 0, 0.06);
        g.add(strip);
        return g;
      },
    },
    {
      id: 'calf-R',
      wave: 'calves',
      kind: 'red',
      pos: [0.12, 0.28, 0],
      build: () => {
        const g = new THREE.Group();
        g.add(cyl(0.1, 0.09, 0.32, mats.red));
        const strip = box(0.04, 0.28, 0.12, mats.gold);
        strip.position.set(0, 0, 0.06);
        g.add(strip);
        return g;
      },
    },
    // —— Thighs ——
    {
      id: 'thigh-L',
      wave: 'thighs',
      kind: 'red',
      pos: [-0.13, 0.58, 0],
      build: () => {
        const g = new THREE.Group();
        g.add(cyl(0.12, 0.1, 0.34, mats.red));
        const knee = box(0.14, 0.08, 0.14, mats.gold);
        knee.position.set(0, -0.14, 0.02);
        g.add(knee);
        return g;
      },
    },
    {
      id: 'thigh-R',
      wave: 'thighs',
      kind: 'red',
      pos: [0.13, 0.58, 0],
      build: () => {
        const g = new THREE.Group();
        g.add(cyl(0.12, 0.1, 0.34, mats.red));
        const knee = box(0.14, 0.08, 0.14, mats.gold);
        knee.position.set(0, -0.14, 0.02);
        g.add(knee);
        return g;
      },
    },
    // —— Hips / waist ——
    {
      id: 'pelvis',
      wave: 'hips',
      kind: 'red',
      pos: [0, 0.86, 0],
      build: () => {
        const g = new THREE.Group();
        g.add(box(0.42, 0.16, 0.28, mats.red));
        const belt = box(0.44, 0.05, 0.3, mats.gold);
        belt.position.y = 0.06;
        g.add(belt);
        return g;
      },
    },
    {
      id: 'codpiece',
      wave: 'hips',
      kind: 'gold',
      pos: [0, 0.78, 0.1],
      build: () => box(0.14, 0.12, 0.1, mats.gold),
    },
    // —— Torso ——
    {
      id: 'abs',
      wave: 'torso',
      kind: 'red',
      pos: [0, 1.05, 0.02],
      build: () => {
        const g = new THREE.Group();
        g.add(box(0.36, 0.22, 0.26, mats.red));
        for (let i = 0; i < 3; i++) {
          const ridge = box(0.28, 0.02, 0.02, mats.dark);
          ridge.position.set(0, -0.06 + i * 0.06, 0.13);
          g.add(ridge);
        }
        return g;
      },
    },
    {
      id: 'chest-L',
      wave: 'torso',
      kind: 'red',
      pos: [-0.14, 1.28, 0.04],
      rot: [0, 0.12, -0.08],
      build: () => box(0.2, 0.26, 0.22, mats.red),
    },
    {
      id: 'chest-R',
      wave: 'torso',
      kind: 'red',
      pos: [0.14, 1.28, 0.04],
      rot: [0, -0.12, 0.08],
      build: () => box(0.2, 0.26, 0.22, mats.red),
    },
    {
      id: 'sternum',
      wave: 'torso',
      kind: 'gold',
      pos: [0, 1.28, 0.14],
      build: () => box(0.1, 0.28, 0.08, mats.gold),
    },
    {
      id: 'back-plate',
      wave: 'torso',
      kind: 'red',
      pos: [0, 1.22, -0.14],
      build: () => {
        const g = new THREE.Group();
        g.add(box(0.4, 0.4, 0.12, mats.red));
        const spine = box(0.06, 0.36, 0.04, mats.gold);
        spine.position.z = -0.05;
        g.add(spine);
        return g;
      },
    },
    {
      id: 'collar',
      wave: 'torso',
      kind: 'gold',
      pos: [0, 1.48, 0.02],
      build: () => box(0.28, 0.08, 0.24, mats.gold),
    },
    // —— Shoulders ——
    {
      id: 'shoulder-L',
      wave: 'shoulders',
      kind: 'red',
      pos: [-0.36, 1.42, 0],
      rot: [0, 0, 0.25],
      build: () => {
        const g = new THREE.Group();
        g.add(sphere(0.14, mats.red, 16, 12));
        const cap = box(0.22, 0.08, 0.2, mats.gold);
        cap.position.set(0, 0.08, 0);
        g.add(cap);
        return g;
      },
    },
    {
      id: 'shoulder-R',
      wave: 'shoulders',
      kind: 'red',
      pos: [0.36, 1.42, 0],
      rot: [0, 0, -0.25],
      build: () => {
        const g = new THREE.Group();
        g.add(sphere(0.14, mats.red, 16, 12));
        const cap = box(0.22, 0.08, 0.2, mats.gold);
        cap.position.set(0, 0.08, 0);
        g.add(cap);
        return g;
      },
    },
    // —— Arms ——
    {
      id: 'upper-arm-L',
      wave: 'arms',
      kind: 'red',
      pos: [-0.42, 1.18, 0],
      rot: [0, 0, 0.15],
      build: () => {
        const g = new THREE.Group();
        g.add(cyl(0.09, 0.08, 0.28, mats.red));
        const stripe = box(0.03, 0.24, 0.1, mats.gold);
        stripe.position.set(0, 0, 0.05);
        g.add(stripe);
        return g;
      },
    },
    {
      id: 'upper-arm-R',
      wave: 'arms',
      kind: 'red',
      pos: [0.42, 1.18, 0],
      rot: [0, 0, -0.15],
      build: () => {
        const g = new THREE.Group();
        g.add(cyl(0.09, 0.08, 0.28, mats.red));
        const stripe = box(0.03, 0.24, 0.1, mats.gold);
        stripe.position.set(0, 0, 0.05);
        g.add(stripe);
        return g;
      },
    },
    {
      id: 'forearm-L',
      wave: 'arms',
      kind: 'red',
      pos: [-0.52, 0.9, 0.02],
      rot: [0.1, 0, 0.1],
      build: () => {
        const g = new THREE.Group();
        g.add(cyl(0.08, 0.07, 0.26, mats.red));
        const plate = box(0.1, 0.2, 0.06, mats.gold);
        plate.position.set(0, 0, 0.05);
        g.add(plate);
        return g;
      },
    },
    {
      id: 'forearm-R',
      wave: 'arms',
      kind: 'red',
      pos: [0.52, 0.9, 0.02],
      rot: [0.1, 0, -0.1],
      build: () => {
        const g = new THREE.Group();
        g.add(cyl(0.08, 0.07, 0.26, mats.red));
        const plate = box(0.1, 0.2, 0.06, mats.gold);
        plate.position.set(0, 0, 0.05);
        g.add(plate);
        return g;
      },
    },
    // —— Gauntlets ——
    {
      id: 'gauntlet-L',
      wave: 'gauntlets',
      kind: 'gold',
      pos: [-0.56, 0.7, 0.04],
      build: () => {
        const g = new THREE.Group();
        g.add(box(0.1, 0.12, 0.14, mats.red));
        const fist = box(0.1, 0.08, 0.12, mats.gold);
        fist.position.set(0, -0.08, 0.02);
        g.add(fist);
        return g;
      },
    },
    {
      id: 'gauntlet-R',
      wave: 'gauntlets',
      kind: 'gold',
      pos: [0.56, 0.7, 0.04],
      build: () => {
        const g = new THREE.Group();
        g.add(box(0.1, 0.12, 0.14, mats.red));
        const fist = box(0.1, 0.08, 0.12, mats.gold);
        fist.position.set(0, -0.08, 0.02);
        g.add(fist);
        return g;
      },
    },
    // —— Helmet ——
    {
      id: 'helmet-shell',
      wave: 'helmet',
      kind: 'red',
      pos: [0, 1.72, 0],
      build: () => {
        const g = new THREE.Group();
        const shell = sphere(0.18, mats.red, 20, 16);
        shell.scale.set(1, 1.05, 1.05);
        g.add(shell);
        const crest = box(0.04, 0.08, 0.28, mats.gold);
        crest.position.set(0, 0.12, 0);
        g.add(crest);
        const jaw = box(0.22, 0.08, 0.16, mats.red);
        jaw.position.set(0, -0.12, 0.04);
        g.add(jaw);
        const chin = box(0.12, 0.05, 0.1, mats.gold);
        chin.position.set(0, -0.16, 0.08);
        g.add(chin);
        return g;
      },
    },
    {
      id: 'faceplate',
      wave: 'helmet',
      kind: 'gold',
      pos: [0, 1.7, 0.12],
      build: () => {
        const g = new THREE.Group();
        const plate = box(0.2, 0.22, 0.06, mats.gold);
        g.add(plate);

        const eyeL = box(0.07, 0.025, 0.02, mats.eye);
        eyeL.position.set(-0.05, 0.04, 0.035);
        eyeL.name = 'eye-L';
        g.add(eyeL);
        eyeMeshes.push(eyeL);

        const eyeR = box(0.07, 0.025, 0.02, mats.eye);
        eyeR.position.set(0.05, 0.04, 0.035);
        eyeR.name = 'eye-R';
        g.add(eyeR);
        eyeMeshes.push(eyeR);

        const mouth = box(0.1, 0.015, 0.02, mats.dark);
        mouth.position.set(0, -0.06, 0.035);
        g.add(mouth);
        return g;
      },
    },
    // —— Arc reactor (power wave) ——
    {
      id: 'reactor',
      wave: 'power',
      kind: 'gold',
      pos: [0, 1.26, 0.22],
      build: () => {
        const g = reactorGroup;
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.07, 0.018, 12, 32),
          mats.reactorRing,
        );
        ring.rotation.x = Math.PI / 2;
        g.add(ring);

        const core = new THREE.Mesh(
          new THREE.SphereGeometry(0.045, 16, 12),
          mats.reactorCore,
        );
        g.add(core);

        const rim = new THREE.Mesh(
          new THREE.RingGeometry(0.085, 0.1, 32),
          mats.gold,
        );
        rim.position.z = 0.01;
        g.add(rim);

        return g;
      },
    },
  ];

  const pieces: ArmorPiece[] = defs.map((def) => {
    const mesh = def.build();
    mesh.name = def.id;

    // Ensure leaf materials are assigned where build used kind only loosely
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
    const startScale = new THREE.Vector3(0.15, 0.15, 0.15);

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
  gauntlets: 'GAUNTLETS ONLINE…',
  helmet: 'HELMET SEALING…',
  power: 'ARC CORE IGNITION…',
};
