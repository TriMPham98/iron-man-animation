import * as THREE from 'three';
import { ARM_DIMS, ROBOT_RING_RADIUS } from './fittingProgram';
import { RobotArm } from './robotArm';
import type { RobotMaterials } from './robotMaterials';
import { boltCircle, drum, lathe } from './robotParts';
import { PLATFORM_RADIUS, PLATFORM_TOP, ROOM_RADIUS } from './workshopEnvironment';

/**
 * Set dressing for the Malibu workshop: the earlier suits on display
 * (Mark I in raw iron, Mark II in polished silver), "Dummy" the helper
 * robot standing by with a fire extinguisher, pegboard tool walls, and a
 * machined trim for the suit-up platform (bolted lip, LED ring, inlaid
 * floor lights round the robot ring).
 */
export interface WorkshopDetail {
  group: THREE.Group;
  update: (dt: number) => void;
}

const WALL = ROOM_RADIUS * Math.cos(Math.PI / 8);

function labelTexture(text: string): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0d1117';
  g.fillRect(0, 0, 256, 64);
  g.strokeStyle = 'rgba(201,162,39,0.8)';
  g.lineWidth = 3;
  g.strokeRect(4, 4, 248, 56);
  g.fillStyle = '#e8e4d9';
  g.font = 'bold 30px monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Pegboard with tool silhouettes. */
function pegboardTexture(seed: number): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.DataTexture(new Uint8Array([40, 44, 50, 255]), 1, 1);
  const W = 1024;
  const H = 640;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2a2e35';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#16191e';
  for (let y = 16; y < H; y += 32) for (let x = 16; x < W; x += 32) g.fillRect(x - 3, y - 3, 6, 6);
  let r = seed * 9301 + 49297;
  const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  const tool = (x: number, y: number, kind: number, len: number) => {
    g.save();
    g.translate(x, y);
    g.fillStyle = kind % 3 === 0 ? '#c9a227' : kind % 3 === 1 ? '#8c1018' : '#b8bec6';
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.lineWidth = 2;
    switch (kind % 5) {
      case 0: // wrench
        g.fillRect(-7, 0, 14, len);
        g.beginPath();
        g.arc(0, 0, 18, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#2a2e35';
        g.fillRect(-7, -20, 14, 18);
        break;
      case 1: // screwdriver
        g.fillRect(-10, 0, 20, len * 0.45);
        g.fillStyle = '#b8bec6';
        g.fillRect(-3, len * 0.45, 6, len * 0.55);
        break;
      case 2: // hammer
        g.fillRect(-5, 0, 10, len);
        g.fillStyle = '#b8bec6';
        g.fillRect(-26, -8, 52, 18);
        break;
      case 3: // pliers
        g.rotate(-0.15);
        g.fillRect(-12, 0, 8, len);
        g.rotate(0.3);
        g.fillRect(4, 0, 8, len);
        break;
      default: // calipers / ruler
        g.fillRect(-6, 0, 12, len);
        g.fillRect(-6, 0, 40, 10);
    }
    g.restore();
  };
  let x = 60;
  let k = Math.floor(rnd() * 5);
  while (x < W - 40) {
    tool(x, 70 + rnd() * 60, k++, 160 + rnd() * 140);
    x += 70 + rnd() * 50;
  }
  // Outline shadow board stripe
  g.fillStyle = 'rgba(201,162,39,0.8)';
  g.fillRect(0, H - 26, W, 8);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function createWorkshopDetail(suitGeometry: THREE.BufferGeometry, mats: RobotMaterials): WorkshopDetail {
  const group = new THREE.Group();
  group.name = 'workshop-detail';

  // ── Hall of armor: Mark I (raw iron) and Mark II (polished) ─────────
  const glass = new THREE.MeshStandardMaterial({
    color: 0x9fdcff,
    metalness: 0.1,
    roughness: 0.05,
    transparent: true,
    opacity: 0.08,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const ringGlow = new THREE.MeshBasicMaterial({ color: 0x7ee8ff, toneMapped: false });
  const displays: Array<{ x: number; z: number; label: string; mat: THREE.Material }> = [
    {
      x: -2.35,
      z: -WALL + 1.0,
      label: 'MARK I',
      mat: new THREE.MeshStandardMaterial({ color: 0x55575b, metalness: 0.75, roughness: 0.62 }),
    },
    {
      x: 2.35,
      z: -WALL + 1.0,
      label: 'MARK II',
      mat: new THREE.MeshStandardMaterial({ color: 0xd8dde3, metalness: 1, roughness: 0.18 }),
    },
  ];
  for (const d of displays) {
    const g = new THREE.Group();
    g.position.set(d.x, 0, d.z);
    g.rotation.y = Math.atan2(-d.x, -d.z);
    // Plinth with a lit ring, glass tube, canopy light
    g.add(lathe([[0, 0], [0.5, 0], [0.52, 0.02], [0.52, 0.12], [0.48, 0.16], [0, 0.16]], mats.dark, 48));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.47, 0.006, 6, 96), ringGlow);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.162;
    g.add(ring);
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 2.05, 48, 1, true), glass);
    tube.position.y = 0.16 + 1.025;
    g.add(tube);
    g.add(lathe([[0, 2.2], [0.5, 2.2], [0.52, 2.24], [0.48, 2.3], [0, 2.3]], mats.dark, 48));
    const down = new THREE.Mesh(new THREE.CircleGeometry(0.3, 32), ringGlow);
    down.rotation.x = Math.PI / 2;
    down.position.y = 2.198;
    g.add(down);
    const suit = new THREE.Mesh(suitGeometry, d.mat);
    suit.position.y = 0.16;
    g.add(suit);
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.3, 0.075),
      new THREE.MeshStandardMaterial({ map: labelTexture(d.label), metalness: 0.4, roughness: 0.5 }),
    );
    plate.position.set(0, 0.08, 0.521);
    g.add(plate);
    group.add(g);
  }

  // ── Dummy, the helper bot, extinguisher at the ready ────────────────
  const dummyAt: [number, number, number] = [4.55, 0.32, -1.45];
  const dummy = new RobotArm('dummy', dummyAt, 'floor', 0.32, mats, 'gripper', ARM_DIMS);
  dummy.group.scale.setScalar(0.72);
  dummy.group.position.y = dummyAt[1] * 0.72;
  // Wheeled base under the column
  const cart = new THREE.Group();
  cart.position.set(dummyAt[0], 0, dummyAt[2]);
  cart.add(drum(0.3, 0.05, 0.11, mats.paint, 0.01, 36));
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const w = drum(0.045, -0.02, 0.02, mats.rubber, 0.006, 16);
    w.rotation.z = Math.PI / 2;
    w.position.set(Math.cos(a) * 0.24, 0.045, Math.sin(a) * 0.24);
    cart.add(w);
  }
  group.add(cart, dummy.group);
  const extinguisher = new THREE.Group();
  extinguisher.add(drum(0.05, -0.17, 0.12, new THREE.MeshStandardMaterial({ color: 0xb01020, metalness: 0.3, roughness: 0.4 }), 0.02, 20));
  extinguisher.add(drum(0.015, 0.12, 0.17, mats.metal, 0.003, 10));
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.012, 0.12, 8), mats.rubber);
  nozzle.rotation.z = 1.2;
  nozzle.position.set(0.05, 0.16, 0);
  extinguisher.add(nozzle);
  extinguisher.rotation.z = Math.PI / 2;
  dummy.hold(extinguisher);
  dummy.setGripper(0.15);
  const dummyPose = (t: number) => {
    const j = dummy.joints;
    j.yaw = 0.35 + 0.12 * Math.sin(t * 0.31);
    j.shoulder = 0.55 + 0.05 * Math.sin(t * 0.47 + 1);
    j.elbow = 1.25 + 0.06 * Math.sin(t * 0.39 + 2);
    j.wristRoll = 0.2 * Math.sin(t * 0.23);
    j.wristPitch = 0.95 + 0.1 * Math.sin(t * 0.53);
    j.flangeRoll = 0;
    dummy.applyJoints();
  };
  dummyPose(0);

  // ── Pegboard tool walls above the side benches ──────────────────────
  for (const [a, seed] of [
    [Math.PI * 0.5, 3],
    [-Math.PI * 0.5, 7],
  ] as const) {
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 1.6),
      new THREE.MeshStandardMaterial({ map: pegboardTexture(seed), metalness: 0.35, roughness: 0.7 }),
    );
    const r = WALL - 0.08;
    board.position.set(Math.sin(a) * r, 1.75, Math.cos(a) * r);
    board.lookAt(0, 1.75, 0);
    group.add(board);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(2.7, 1.7, 0.04), mats.dark);
    frame.position.copy(board.position).addScaledVector(board.position.clone().setY(0).normalize(), 0.025);
    frame.lookAt(0, 1.75, 0);
    group.add(frame);
  }

  // ── Platform trim: bolted lip, LED ring, hatch bolts ────────────────
  const R = PLATFORM_RADIUS;
  const top = PLATFORM_TOP;
  group.add(lathe([[R + 0.008, 0], [R + 0.045, 0], [R + 0.045, top + 0.002], [R + 0.035, top + 0.007], [R + 0.008, top + 0.007], [R + 0.008, 0]], mats.metal, 128));
  group.add(...boltCircle(48, R + 0.026, [0, top + 0.007, 0], 'y', mats.dark, 0.006));
  const led = new THREE.MeshBasicMaterial({ color: 0x7ee8ff, toneMapped: false });
  const dashGeo = new THREE.BoxGeometry(0.06, 0.003, 0.012);
  for (let k = 0; k < 36; k++) {
    const a = (k / 36) * Math.PI * 2;
    const dash = new THREE.Mesh(dashGeo, led);
    dash.position.set(Math.cos(a) * 0.86, top + 0.0012, Math.sin(a) * 0.86);
    dash.rotation.y = -a + Math.PI / 2;
    group.add(dash);
  }
  group.add(...boltCircle(16, 0.37, [0, top, 0], 'y', mats.metal, 0.006, Math.PI / 16));
  // Inlaid floor lights round the outside of the robot ring
  const inlay = new THREE.CylinderGeometry(0.028, 0.028, 0.004, 16);
  const inlayMat = new THREE.MeshBasicMaterial({ color: 0x5cc8ef, toneMapped: false });
  for (let k = 0; k < 24; k++) {
    const a = ((k + 0.5) / 24) * Math.PI * 2;
    const l = new THREE.Mesh(inlay, inlayMat);
    l.position.set(Math.cos(a) * (ROBOT_RING_RADIUS + 0.33), 0.001, Math.sin(a) * (ROBOT_RING_RADIUS + 0.33));
    group.add(l);
  }

  let clock = 0;
  return {
    group,
    update: (dt) => {
      clock += dt;
      dummyPose(clock);
      led.color.setHSL(0.53, 0.9, 0.62 + 0.08 * Math.sin(clock * 2.2));
    },
  };
}
