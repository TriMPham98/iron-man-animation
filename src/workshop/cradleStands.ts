import * as THREE from 'three';
import { cradleFor, FIT_TASKS, ROBOTS, type FitTask } from './fittingProgram';
import type { RobotMaterials } from './robotMaterials';
import { block, drum, slabX } from './robotParts';

/** Floor port a cradle post telescopes through (m). */
export const CRADLE_PORT_RADIUS = 0.078;
/** Port lid radius and how far it parks out under the floor. */
export const LID_RADIUS = CRADLE_PORT_RADIUS + 0.01;
export const LID_TRAVEL = 2 * CRADLE_PORT_RADIUS + 0.03;
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
  return floorCradlePorts().map(([x, z]) => {
    let best: [number, number] = [1, 0];
    let bestGap = -Infinity;
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const lx = x + dx * LID_TRAVEL;
      const lz = z + dz * LID_TRAVEL;
      let gap = Infinity;
      for (const [hx, hz, hr] of holes) {
        if (Math.hypot(hx - x, hz - z) < 1e-6) continue;
        gap = Math.min(gap, Math.hypot(lx - hx, lz - hz) - hr - LID_RADIUS);
      }
      const d = Math.hypot(lx, lz);
      for (const [r0, r1] of rings) gap = Math.min(gap, Math.max(r0 - d, d - r1) - LID_RADIUS);
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

/** World (x, z) of every floor cradle port (cut out of the floor). */
export function floorCradlePorts(): Array<[number, number]> {
  return cradleTasks()
    .filter((t) => !hangs(t))
    .map((t) => {
      const c = cradleFor(t);
      return [c[0], c[2]];
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
    const P = CRADLE_PORT_RADIUS;
    const pitGeo = new THREE.CylinderGeometry(P, P, 1.4, 32, 1, true);
    const trimGeo = new THREE.RingGeometry(P, P + 0.016, 40);

    for (const task of cradleTasks()) {
      const c = cradleFor(task);
      const { bottom, top } = bounds(task);
      const hanging = hangs(task);
      const port = new THREE.Group();
      port.position.set(c[0], 0, c[2]);
      this.group.add(port);

      if (!hanging) {
        const h = Math.max(0.1, bottom - 0.005);
        // Port: pit + flush trim ring
        const pit = new THREE.Mesh(pitGeo, pitMat);
        pit.position.y = -0.7;
        port.add(pit);
        const trim = new THREE.Mesh(trimGeo, trimMat);
        trim.rotation.x = -Math.PI / 2;
        trim.position.y = 0.0015;
        port.add(trim);

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
        const lid = drum(LID_RADIUS, LID_TOP - 0.02, LID_TOP, mats.paint, 0.003, 32);
        lid.userData.dynamic = true;
        const [dx, dz] = lidDirs[floorIndex++];
        const lidOpen = new THREE.Vector3(dx, 0, dz).multiplyScalar(LID_TRAVEL);
        port.add(lid);
        this.stands.push({
          task,
          hanging,
          stroke: h + 0.03,
          head,
          sleeve,
          lid,
          lidOpen,
          lidClosed: new THREE.Vector3(),
          u: -1,
        });
      } else {
        port.position.y = ceilingY;
        const trim = new THREE.Mesh(trimGeo, trimMat);
        trim.rotation.x = Math.PI / 2;
        trim.position.y = -0.0015;
        port.add(trim);
        const iris = new THREE.Mesh(new THREE.CircleGeometry(P, 32), mats.dark);
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
          stroke: -hook + 0.06,
          head,
          sleeve: null,
          lid: iris,
          lidOpen: new THREE.Vector3(),
          lidClosed: new THREE.Vector3(),
          u: -1,
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

  /** Reset handoff: all stands rise (u = 1 → fully deployed). */
  setDeployed(u: number): void {
    const k = 1 - THREE.MathUtils.smoothstep(u, 0.02, 0.34);
    for (const s of this.stands) this.setRetract(s, k);
  }
}
