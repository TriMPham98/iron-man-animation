import * as THREE from 'three';
import { cradleFor, cradlePortRadius, FIT_TASKS, ROBOTS, type FitTask } from './fittingProgram';
import type { RobotMaterials } from './robotMaterials';
import { block, drum, slabX } from './robotParts';

/**
 * Port lid radius and how far it parks out under the floor, for a port of
 * radius r (ports are sized to their parts: see cradlePortRadius).
 */
export const lidRadius = (r: number): number => r + 0.01;
export const lidTravel = (r: number): number => 2 * r + 0.03;
/** Lid top sits just under the floor plane (flush, never coplanar). */
const LID_TOP = -0.003;
/** Retract stroke time (s). */
export const STAND_RETRACT_SEC = 1.15;

/** Tasks whose parts wait on a stand (floor) or hanger (ceiling). */
export function cradleTasks(): FitTask[] {
  return FIT_TASKS.filter((t) => !!t.robot);
}

function hangs(task: FitTask): boolean {
  return ROBOTS.find((r) => r.id === task.robot)!.mount === 'ceiling';
}

/**
 * Direction each port's lid parks in: the one whose parked disc stays
 * furthest from every other floor opening (so it is never seen through one).
 */
export function lidDirections(
  holes: Array<[number, number, number]>,
  rings: Array<[number, number]> = [],
): Array<[number, number]> {
  return floorCradlePorts().map(([x, z, r]) => {
    const lr = lidRadius(r);
    const travel = lidTravel(r);
    let best: [number, number] = [1, 0];
    let bestGap = -Infinity;
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const lx = x + dx * travel;
      const lz = z + dz * travel;
      let gap = Infinity;
      for (const [hx, hz, hr] of holes) {
        if (Math.hypot(hx - x, hz - z) < 1e-6) continue;
        gap = Math.min(gap, Math.hypot(lx - hx, lz - hz) - hr - lr);
      }
      const d = Math.hypot(lx, lz);
      for (const [r0, r1] of rings) gap = Math.min(gap, Math.max(r0 - d, d - r1) - lr);
      // Prefer parking away from the suit when several are clear
      gap += 0.02 * (dx * x + dz * z) / Math.max(1e-6, Math.hypot(x, z));
      if (gap > bestGap) {
        bestGap = gap;
        best = [dx, dz];
      }
    }
    return best;
  });
}

/** World (x, z) and radius of every floor cradle port (cut out of the floor). */
export function floorCradlePorts(): Array<[number, number, number]> {
  return cradleTasks()
    .filter((t) => !hangs(t))
    .map((t) => {
      const c = cradleFor(t);
      return [c[0], c[2], cradlePortRadius(t)];
    });
}

interface Stand {
  task: FitTask;
  hanging: boolean;
  /** Full stroke to stow (m). */
  stroke: number;
  head: THREE.Group;
  sleeve: THREE.Group | null;
  lid: THREE.Object3D | null;
  lidOpen: THREE.Vector3;
  lidClosed: THREE.Vector3;
  /** Retract 0 (up, holding) → 1 (stowed). */
  u: number;
  /** World-y shift of the cradle head from its up position (− = down). */
  shift: number;
}

/**
 * Parts cradles that disappear once their part has been taken, as in the
 * film: floor stands telescope down through a flush port and a lid slides
 * shut over them; hangers draw up into the ceiling and an iris closes.
 */
export class CradleStands {
  readonly group = new THREE.Group();
  private readonly stands: Stand[] = [];

  /**
   * @param bounds bottom / top (world y) of each task's parts on the cradle
   */
  constructor(
    mats: RobotMaterials,
    bounds: (task: FitTask) => { bottom: number; top: number },
    ceilingY: number,
    /** Every floor opening (x, z, r) — lids park clear of all of them. */
    floorHoles: Array<[number, number, number]>,
    floorRings: Array<[number, number]> = [],
  ) {
    const lidDirs = lidDirections(floorHoles, floorRings);
    let floorIndex = 0;
    this.group.name = 'cradles';
    const pitMat = new THREE.MeshStandardMaterial({ color: 0x0b0d10, metalness: 0.5, roughness: 0.7, side: THREE.BackSide });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0xc8782a,
      metalness: 0.4,
      roughness: 0.45,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    // Ceiling shafts read as openings while their iris is open
    const shaftMat = new THREE.MeshBasicMaterial({ color: 0x030405 });

    // Pits + trims of every port share one static group (merged to a
    // couple of draw calls); only the moving parts live per port
    const statics = new THREE.Group();
    statics.name = 'cradle-ports';
    this.group.add(statics);
    for (const task of cradleTasks()) {
      const c = cradleFor(task);
      const { bottom, top } = bounds(task);
      const hanging = hangs(task);
      const P = cradlePortRadius(task);
      const trimGeo = new THREE.RingGeometry(P, P + 0.016, 48);
      const port = new THREE.Group();
      port.name = `port-${task.id}`;
      port.position.set(c[0], 0, c[2]);
      this.group.add(port);

      if (!hanging) {
        const h = Math.max(0.1, bottom - 0.005);
        // Port: pit + flush trim ring
        const pit = new THREE.Mesh(new THREE.CylinderGeometry(P, P, 1.4, 40, 1, true), pitMat);
        pit.position.set(c[0], -0.7, c[2]);
        statics.add(pit);
        const trim = new THREE.Mesh(trimGeo, trimMat);
        trim.rotation.x = -Math.PI / 2;
        trim.position.set(c[0], 0.0015, c[2]);
        statics.add(trim);

        // Sleeve (rides half the stroke) + chrome ram + cradle head
        const sleeve = new THREE.Group();
        sleeve.userData.dynamic = true;
        const sTop = h * 0.45;
        sleeve.add(drum(0.06, -1.2, sTop, mats.dark, 0.004, 24));
        sleeve.add(drum(0.064, sTop - 0.03, sTop, mats.metal, 0.003, 24));
        sleeve.add(drum(0.0625, sTop - 0.12, sTop - 0.1, mats.accent, 0.001, 24));
        port.add(sleeve);

        const head = new THREE.Group();
        head.userData.dynamic = true;
        head.add(drum(0.04, sTop - 0.4, h - 0.055, mats.chrome, 0.002, 20));
        head.add(drum(0.07, h - 0.06, h - 0.042, mats.metal, 0.003, 32));
        head.add(drum(0.05, h - 0.075, h - 0.06, mats.dark, 0.003, 24));
        // Saddle: two padded jaws (fits through the port)
        const jaw: Array<[number, number]> = [
          [-0.035, h - 0.043],
          [0.035, h - 0.043],
          [0.035, h],
          [-0.035, h],
        ];
        for (const s of [-1, 1]) {
          const j = slabX(jaw, s > 0 ? 0.016 : -0.055, s > 0 ? 0.055 : -0.016, mats.accent, 0.004);
          head.add(j);
          head.add(block(0.018, 0.004, 0.06, mats.rubber, s * 0.036, h + 0.001, 0));
        }
        head.add(block(0.025, 0.006, 0.004, mats.led, 0, h - 0.051, 0.0705));
        port.add(head);

        // Lid slides out radially, under the floor
        const lid = drum(lidRadius(P), LID_TOP - 0.02, LID_TOP, mats.paint, 0.003, 40);
        lid.userData.dynamic = true;
        const [dx, dz] = lidDirs[floorIndex++];
        const lidOpen = new THREE.Vector3(dx, 0, dz).multiplyScalar(lidTravel(P));
        port.add(lid);
        this.stands.push({
          task,
          hanging,
          // Deep enough to take the whole part below the deck with it
          stroke: Math.max(h, top) + 0.03,
          head,
          sleeve,
          lid,
          lidOpen,
          lidClosed: new THREE.Vector3(),
          u: -1,
          shift: 0,
        });
      } else {
        port.position.y = ceilingY;
        const trim = new THREE.Mesh(trimGeo, trimMat);
        trim.rotation.x = Math.PI / 2;
        trim.position.set(c[0], ceilingY - 0.0015, c[2]);
        statics.add(trim);
        // Open shaft (dark) under an iris plate that closes over it
        const shaft = new THREE.Mesh(new THREE.CircleGeometry(P, 40), shaftMat);
        shaft.rotation.x = Math.PI / 2;
        shaft.position.set(c[0], ceilingY - 0.001, c[2]);
        statics.add(shaft);
        const iris = new THREE.Mesh(new THREE.CircleGeometry(P, 40), mats.metal);
        iris.rotation.x = Math.PI / 2;
        iris.position.y = -0.002;
        iris.userData.dynamic = true;
        port.add(iris);

        const hook = top + 0.012 - ceilingY;
        const head = new THREE.Group();
        head.userData.dynamic = true;
        head.add(drum(0.018, hook + 0.02, 0.3, mats.chrome, 0.002, 16));
        head.add(drum(0.03, hook + 0.04, hook + 0.09, mats.dark, 0.003, 20));
        head.add(drum(0.08, hook, hook + 0.018, mats.accent, 0.003, 32));
        for (const s of [-1, 1]) head.add(block(0.012, 0.05, 0.06, mats.metal, s * 0.07, hook - 0.02, 0));
        port.add(head);
        this.stands.push({
          task,
          hanging,
          // Up past the ceiling with the part it carries
          stroke: Math.max(-hook + 0.06, ceilingY - bottom + 0.03),
          head,
          sleeve: null,
          lid: iris,
          lidOpen: new THREE.Vector3(),
          lidClosed: new THREE.Vector3(),
          u: -1,
          shift: 0,
        });
      }
    }
    for (const s of this.stands) this.setRetract(s, 0);
  }

  private setRetract(s: Stand, u: number): void {
    const k = THREE.MathUtils.clamp(u, 0, 1);
    if (k === s.u) return;
    s.u = k;
    // The head runs the stroke, then the lid / iris closes over the port
    const travel = THREE.MathUtils.smoothstep(k, 0, 0.78) * s.stroke;
    const close = THREE.MathUtils.smoothstep(k, 0.8, 1);
    s.shift = s.hanging ? travel : -travel;
    if (s.hanging) {
      s.head.position.y = travel;
      s.head.visible = k < 0.999;
      if (s.lid) s.lid.visible = close > 0.5;
      return;
    }
    s.head.position.y = -travel;
    if (s.sleeve) s.sleeve.position.y = -travel * 0.5;
    s.head.visible = s.sleeve!.visible = k < 0.999;
    s.lid?.position.lerpVectors(s.lidOpen, s.lidClosed, close);
  }

  /** Retract every stand whose part has left it by time t. */
  apply(retractStart: (task: FitTask) => number, t: number): void {
    for (const s of this.stands) {
      const t0 = retractStart(s.task);
      this.setRetract(s, (t - t0) / STAND_RETRACT_SEC);
    }
  }

  /**
   * How far a task's cradle head has moved from its holding position
   * (world y, + = up into the ceiling): a part still on it rides along.
   */
  shift(taskId: string): number {
    return this.stands.find((s) => s.task.id === taskId)?.shift ?? 0;
  }

  /** Reset handoff: all stands rise (u = 1 → fully deployed). */
  setDeployed(u: number): void {
    const k = 1 - THREE.MathUtils.smoothstep(u, 0.02, 0.34);
    for (const s of this.stands) this.setRetract(s, k);
  }
}
