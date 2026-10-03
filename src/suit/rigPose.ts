import * as THREE from 'three';
import { BONE_NAMES, BONE_SPECS, type BoneName } from './rig';

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

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _X = new THREE.Vector3(1, 0, 0);
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
export function applyPose(rig: SuitRig, pose: SuitPose): void {
  const b = rig.bones;
  const st = pose.stance;

  // Arms: abduct out to the sides, then reach slightly forward.
  // .L lives on +X, so raising it is +Z rotation; .R mirrors.
  for (const [side, s] of [
    ['L', 1],
    ['R', -1],
  ] as const) {
    setAxisAngles(
      b[`upperArm.${side}`],
      [_Z, s * STANCE_ARM_RAISE * st],
      [_X, -STANCE_ARM_FORWARD * st],
    );
    setAxisAngles(b[`forearm.${side}`], [_X, -STANCE_ELBOW * st]);
    const wrist = side === 'L' ? pose.wristL : pose.wristR;
    setAxisAngles(b[`hand.${side}`], [
      _Z,
      s * (WRIST_EXTENSION * wrist - STANCE_WRIST * st),
    ]);
    setAxisAngles(b[`thigh.${side}`], [_Z, s * STANCE_LEG_SPREAD * st]);
    setAxisAngles(b[`foot.${side}`], [_Z, -s * STANCE_LEG_SPREAD * st]);
  }

  setAxisAngles(b.chest, [_X, -CHEST_RECOIL * pose.chestRecoil]);
  setAxisAngles(b.head, [_X, pose.headPitch]);
}
