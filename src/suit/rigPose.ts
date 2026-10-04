import * as THREE from 'three';
import { BONE_NAMES, BONE_SPECS, FINGERS, HINGES, type BoneName, type Finger } from './rig';

/**
 * Scalar pose channels the suit-up choreography animates. Every channel is 0
 * at the bind pose, so a zeroed pose is exactly the modelled hero stance
 * (and what the seamless mesh / diagnostic wireframe are built from).
 */
export interface SuitPose {
  /** 0 = arms at the sides, 1 = Mark III suit-up stance (arms out). */
  stance: number;
  /** Chest recoil when the chest plate slams home (+ = rocks back). */
  chestRecoil: number;
  /** Head pitch in radians (− = chin up). */
  headPitch: number;
  /** Wrist extension, 0–1 (repulsor "stop" gesture). */
  wristL: number;
  wristR: number;
}

/**
 * Extra channels the post-assembly flight-control check drives (absent =
 * 0, so suit-up poses never carry them).
 */
export interface FlightPose extends SuitPose {
  /** Head yaw in radians (+ = turn to the suit's left). */
  headYaw?: number;
  /** Whole-suit hover above the platform (m) — thruster test. */
  lift?: number;
  /**
   * In-flight attitude (rad) about the centre of mass: + pitch leans the
   * suit forward, + roll leans it to its own right.
   */
  pitch?: number;
  roll?: number;
  /** In-flight drift off the pad centre (m, model space). */
  driftX?: number;
  driftZ?: number;
  /** Breathing phase −1…1 (chest swell, shoulders, a settling head). */
  breath?: number;
  /** Head tilt in radians (+ = ear toward the suit's left shoulder). */
  headRoll?: number;
  /** Additive limb offsets (rad) for live balance in flight. */
  limbs?: LimbOffsets;
  /** 0 = modelled stance (~30 cm between the boots), 1 = feet together. */
  legsIn?: number;
  /**
   * Finger curl per hand, [thumb, index, middle, ring, pinky]:
   * 0 = as modelled, 1 = fist, negative = straightened / splayed.
   */
  fingersL?: readonly number[];
  fingersR?: readonly number[];
}

/**
 * Per-side additive joint offsets (rad). Arms: `arm` raises the arm out to
 * the side, `elbow` bends it. Legs: `hip` swings the leg forward, `hipOut`
 * spreads it, `knee` bends it, `ankle` points the toes down, `footRoll`
 * banks the sole (+ = toward the suit's own left).
 */
export interface LimbOffsets {
  armL?: number;
  armR?: number;
  elbowL?: number;
  elbowR?: number;
  hipL?: number;
  hipR?: number;
  hipOutL?: number;
  hipOutR?: number;
  kneeL?: number;
  kneeR?: number;
  ankleL?: number;
  ankleR?: number;
  footRollL?: number;
  footRollR?: number;
}

/** Max curl (rad) of proximal / distal phalanges at curl 1. */
const FINGER_CURL = [1.25, 1.35] as const;
const FINGER_CURL_THUMB = [0.7, 0.9] as const;

const curlAxes = new Map<string, THREE.Vector3>();
/**
 * Curl axis of a finger (bind = bone-local): ⊥ to the finger and the palm
 * normal, signed so positive curl folds the tip into the palm.
 */
function curlAxis(f: Finger, side: 'L' | 'R'): THREE.Vector3 {
  const key = `${f}.${side}`;
  let a = curlAxes.get(key);
  if (!a) {
    const spec = BONE_SPECS.find((s) => s.name === `${f}1.${side}`)!;
    const dir = new THREE.Vector3(...spec.tail).sub(new THREE.Vector3(...spec.head)).normalize();
    const palm = new THREE.Vector3(side === 'L' ? -1 : 1, 0, f === 'thumb' ? -0.6 : 0).normalize();
    a = new THREE.Vector3().crossVectors(dir, palm).normalize();
    curlAxes.set(key, a);
  }
  return a;
}

/** Thigh adduction that brings the boots together (rad). */
const LEGS_IN = 0.085;

export const BIND_POSE: Readonly<SuitPose> = {
  stance: 0,
  chestRecoil: 0,
  headPitch: 0,
  wristL: 0,
  wristR: 0,
};

/** Shoulder abduction in the suit-up stance (arms raised out to the sides). */
export const STANCE_ARM_RAISE = 1.12;
/** Slight forward reach so the arms read in a ¾ camera. */
const STANCE_ARM_FORWARD = 0.2;
/** Soft elbow bend in the stance. */
const STANCE_ELBOW = 0.22;
/** Wrists level the hands with the forearm (palms down). */
const STANCE_WRIST = 0.12;
/** Feet spread a touch for the wide stance. */
const STANCE_LEG_SPREAD = 0.035;
/** Max wrist extension for the repulsor check. */
const WRIST_EXTENSION = 1.0;
/** Chest recoil at value 1 (radians). */
const CHEST_RECOIL = 0.07;

export interface SuitRig {
  root: THREE.Bone;
  bones: Record<BoneName, THREE.Bone>;
  /** Created by {@link bindRig} once the rig sits at its final world pose. */
  skeleton: THREE.Skeleton | null;
}

/** Build bones at the bind pose (identity rotations, offsets from parent). */
export function createRig(): SuitRig {
  const bones = {} as Record<BoneName, THREE.Bone>;
  for (const spec of BONE_SPECS) {
    const bone = new THREE.Bone();
    bone.name = spec.name;
    bones[spec.name] = bone;
  }
  for (const spec of BONE_SPECS) {
    const bone = bones[spec.name];
    if (spec.parent) {
      const p = BONE_SPECS.find((s) => s.name === spec.parent)!;
      bone.position.set(
        spec.head[0] - p.head[0],
        spec.head[1] - p.head[1],
        spec.head[2] - p.head[2],
      );
      bones[spec.parent].add(bone);
    } else {
      bone.position.set(spec.head[0], spec.head[1], spec.head[2]);
    }
  }
  return { root: bones.root, bones, skeleton: null };
}

/**
 * Create the skeleton (bone inverses from the current world matrices).
 * Call after the rig's parent group is placed in the scene.
 */
export function bindRig(rig: SuitRig): THREE.Skeleton {
  rig.root.updateWorldMatrix(true, true);
  const ordered = BONE_NAMES.map((n) => rig.bones[n]);
  rig.skeleton = new THREE.Skeleton(ordered);
  return rig.skeleton;
}

/** Breathing amplitude (rad) per bone at breath = 1. */
const BREATH_SPINE = 0.006;
const BREATH_CHEST = 0.014;
const BREATH_SHOULDER = 0.008;
/** Hover tilt pivot (bind space): about the hips. */
const CENTRE_OF_MASS = new THREE.Vector3(0, 1.0, 0);
const _p = new THREE.Vector3();
const _I = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _X = new THREE.Vector3(1, 0, 0);
const _Y = new THREE.Vector3(0, 1, 0);
const _Z = new THREE.Vector3(0, 0, 1);

function setAxisAngles(
  bone: THREE.Bone,
  first: [THREE.Vector3, number],
  second?: [THREE.Vector3, number],
): void {
  _qa.setFromAxisAngle(first[0], first[1]);
  if (second) {
    _qb.setFromAxisAngle(second[0], second[1]);
    bone.quaternion.multiplyQuaternions(_qb, _qa);
  } else {
    bone.quaternion.copy(_qa);
  }
}

/** Write pose channels into the bone rotations (positions never change). */
export function applyPose(rig: SuitRig, pose: FlightPose): void {
  const b = rig.bones;
  const st = pose.stance;

  // Arms: abduct out to the sides, then reach slightly forward.
  // .L lives on +X, so raising it is +Z rotation; .R mirrors.
  const lb = pose.limbs ?? {};
  for (const [side, s] of [
    ['L', 1],
    ['R', -1],
  ] as const) {
    const o = (k: 'arm' | 'elbow' | 'hip' | 'hipOut' | 'knee' | 'ankle' | 'footRoll') =>
      lb[`${k}${side}` as keyof LimbOffsets] ?? 0;
    setAxisAngles(
      b[`upperArm.${side}`],
      // Shoulders ride the breath a touch
      [_Z, s * (STANCE_ARM_RAISE * st + BREATH_SHOULDER * (pose.breath ?? 0) + o('arm'))],
      [_X, -STANCE_ARM_FORWARD * st],
    );
    setAxisAngles(b[`forearm.${side}`], [_X, -STANCE_ELBOW * st - o('elbow')]);
    const wrist = side === 'L' ? pose.wristL : pose.wristR;
    setAxisAngles(b[`hand.${side}`], [
      _Z,
      s * (WRIST_EXTENSION * wrist - STANCE_WRIST * st),
    ]);
    const legs = STANCE_LEG_SPREAD * st - LEGS_IN * (pose.legsIn ?? 0) + o('hipOut');
    setAxisAngles(b[`thigh.${side}`], [_Z, s * legs], [_X, -o('hip')]);
    setAxisAngles(b[`shin.${side}`], [_X, o('knee')]);
    // Soles stay flat on the deck unless the ankle is vectoring thrust
    setAxisAngles(b[`foot.${side}`], [_Z, -s * legs + o('footRoll')], [_X, o('ankle') - o('knee') + o('hip')]);
  }

  for (const [side, curl] of [
    ['L', pose.fingersL],
    ['R', pose.fingersR],
  ] as const) {
    FINGERS.forEach((f, i) => {
      const k = curl?.[i] ?? 0;
      const p1 = b[`${f}1.${side}` as BoneName];
      const p2 = b[`${f}2.${side}` as BoneName];
      if (Math.abs(k) < 1e-5) {
        p1.quaternion.identity();
        p2.quaternion.identity();
        return;
      }
      const max = f === 'thumb' ? FINGER_CURL_THUMB : FINGER_CURL;
      p1.quaternion.setFromAxisAngle(curlAxis(f, side), k * max[0]);
      p2.quaternion.setFromAxisAngle(curlAxis(f, side), k * max[1]);
    });
  }

  // Hinge helpers turn half as far as the lower limb (round elbow / knee)
  for (const h of HINGES) b[h.helper].quaternion.slerpQuaternions(_I, b[h.lower].quaternion, 0.5);

  // Breathing: the chest swells (rocks back a hair) and the head
  // counters it so the gaze stays level
  const breath = pose.breath ?? 0;
  setAxisAngles(b.spine, [_X, -BREATH_SPINE * breath]);
  setAxisAngles(b.chest, [_X, -CHEST_RECOIL * pose.chestRecoil - BREATH_CHEST * breath]);
  setAxisAngles(b.head, [_X, pose.headPitch + (BREATH_SPINE + BREATH_CHEST) * breath * 0.8], [_Y, pose.headYaw ?? 0]);
  if (pose.headRoll) b.head.quaternion.premultiply(_qa.setFromAxisAngle(_Z, pose.headRoll));

  // Root sits at the origin in the bind pose; hover moves the whole rig and
  // tilts it about the centre of mass (not the soles)
  const pitch = pose.pitch ?? 0;
  const roll = pose.roll ?? 0;
  _qa.setFromAxisAngle(_X, pitch);
  _qb.setFromAxisAngle(_Z, roll);
  rig.root.quaternion.multiplyQuaternions(_qa, _qb);
  _p.copy(CENTRE_OF_MASS).applyQuaternion(rig.root.quaternion);
  rig.root.position.set(
    (pose.driftX ?? 0) + CENTRE_OF_MASS.x - _p.x,
    (pose.lift ?? 0) + CENTRE_OF_MASS.y - _p.y,
    (pose.driftZ ?? 0) + CENTRE_OF_MASS.z - _p.z,
  );
}
