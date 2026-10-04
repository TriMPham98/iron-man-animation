import * as THREE from 'three';
import { cradleFor, cradlePortRadius, FIT_TASKS, ROBOTS, type FitTask } from './fittingProgram';
import type { RobotMaterials } from './robotMaterials';
import { block, drum, slabX } from './robotParts';

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
 * World (x, z) and footprint radius of every floor cradle: the room its
 * stand and parts need to sink through the ring aperture.
 */
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
  /** Ceiling hanger's shutter plate. */
  shutter: THREE.Object3D | null;
  /** Retract 0 (up, holding) → 1 (stowed). */
  u: number;
  /** World-y shift of the cradle head from its up position (− = down). */
  shift: number;
}

/**
 * Parts cradles that disappear once their part has been taken, as in the
 * film: floor stands telescope down into the pit under the ring aperture;
 * hangers draw up into the ceiling and a shutter closes.
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
  ) {
    this.group.name = 'cradles';
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

    // Ceiling trims + shafts share one static group (merged to a couple
    // of draw calls); only the moving parts live per stand
    const statics = new THREE.Group();
    statics.name = 'cradle-ports';
    this.group.add(statics);
    for (const task of cradleTasks()) {
      const c = cradleFor(task);
      const { bottom, top } = bounds(task);
      const hanging = hangs(task);
      const P = cradlePortRadius(task);
      const port = new THREE.Group();
      port.name = `port-${task.id}`;
      port.position.set(c[0], 0, c[2]);
      this.group.add(port);

      if (!hanging) {
        const h = Math.max(0.1, bottom - 0.005);
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
        // Saddle: two padded jaws
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
        this.stands.push({
          task,
          hanging,
          // Deep enough to take the whole part under the aperture plates
          stroke: Math.max(h, top) + 0.05,
          head,
          sleeve,
          shutter: null,
          u: -1,
          shift: 0,
        });
      } else {
        port.position.y = ceilingY;
        const trim = new THREE.Mesh(new THREE.RingGeometry(P, P + 0.016, 48), trimMat);
        trim.rotation.x = Math.PI / 2;
        trim.position.set(c[0], ceilingY - 0.0015, c[2]);
        statics.add(trim);
        // Open shaft (dark) under a shutter plate that closes over it
        const shaft = new THREE.Mesh(new THREE.CircleGeometry(P, 40), shaftMat);
        shaft.rotation.x = Math.PI / 2;
        shaft.position.set(c[0], ceilingY - 0.001, c[2]);
        statics.add(shaft);
        const shutter = new THREE.Mesh(new THREE.CircleGeometry(P, 40), mats.metal);
        shutter.rotation.x = Math.PI / 2;
        shutter.position.y = -0.002;
        shutter.userData.dynamic = true;
        port.add(shutter);

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
          shutter,
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
    // The head runs the stroke (a hanger's shutter then closes over it)
    const travel = THREE.MathUtils.smoothstep(k, 0, 0.78) * s.stroke;
    s.shift = s.hanging ? travel : -travel;
    if (s.hanging) {
      s.head.position.y = travel;
      s.head.visible = k < 0.999;
      if (s.shutter) s.shutter.visible = k > 0.9;
      return;
    }
    s.head.position.y = -travel;
    if (s.sleeve) s.sleeve.position.y = -travel * 0.5;
    s.head.visible = s.sleeve!.visible = k < 0.999;
  }

  /** Set every stand's retract stroke: 0 = up, holding → 1 = stowed. */
  apply(retract: (task: FitTask) => number): void {
    for (const s of this.stands) this.setRetract(s, retract(s.task));
  }

  /**
   * How far a task's cradle head has moved from its holding position
   * (world y, + = up into the ceiling): a part still on it rides along.
   */
  shift(taskId: string): number {
    return this.stands.find((s) => s.task.id === taskId)?.shift ?? 0;
  }

  /** Reset handoff: all stands rise (u = 0 → stowed, 1 → fully deployed), ahead of the arms. */
  setDeployed(u: number): void {
    const k = 1 - THREE.MathUtils.smoothstep(u, 0, 0.45);
    for (const s of this.stands) this.setRetract(s, k);
  }
}
