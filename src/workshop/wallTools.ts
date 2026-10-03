import * as THREE from 'three';

/**
 * Hand tools hung on a pegboard — modelled, not painted: combination
 * wrenches, an adjustable, screwdrivers, a claw hammer, pliers, a tape
 * measure, a cordless drill and a coiled extension lead, each on its own
 * pegs. Board-local frame: x across, y up, z out of the board (0 = board
 * face). Plain finishes only, so the whole wall merges to one draw.
 */

const chrome = new THREE.MeshStandardMaterial({ color: 0xc9ced4, metalness: 1, roughness: 0.22 });
/** Brushed steel for flat faces (mirror chrome reads black on a flat plate). */
const satin = new THREE.MeshStandardMaterial({ color: 0xb4bac2, metalness: 0.75, roughness: 0.42 });
const steelDark = new THREE.MeshStandardMaterial({ color: 0x4a4f56, metalness: 0.9, roughness: 0.4 });
const gripRed = new THREE.MeshStandardMaterial({ color: 0x9a1418, metalness: 0, roughness: 0.65 });
const gripBlack = new THREE.MeshStandardMaterial({ color: 0x141518, metalness: 0, roughness: 0.8 });
const amberPlastic = new THREE.MeshStandardMaterial({ color: 0xd08a1e, metalness: 0.05, roughness: 0.45 });
const yellow = new THREE.MeshStandardMaterial({ color: 0xe6c21a, metalness: 0.05, roughness: 0.5 });
const cableOrange = new THREE.MeshStandardMaterial({ color: 0xd2571a, metalness: 0, roughness: 0.6 });

const cyl = (r0: number, r1: number, len: number, m: THREE.Material, seg = 12) => new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, len, seg), m);
const cube = (w: number, h: number, d: number, m: THREE.Material) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);

/** Pegboard hook: a short pin out of the board with an upturned tip. */
function peg(x: number, y: number): THREE.Object3D {
  const g = new THREE.Group();
  const pin = cyl(0.0035, 0.0035, 0.05, chrome, 8);
  pin.rotation.x = Math.PI / 2;
  pin.position.set(x, y, 0.025);
  const tip = cyl(0.0035, 0.0035, 0.014, chrome, 8);
  tip.position.set(x, y + 0.006, 0.05);
  g.add(pin, tip);
  return g;
}

/** Combination spanner hanging from its ring end. */
function wrench(len: number): THREE.Group {
  const g = new THREE.Group();
  const shaft = cube(len * 0.11, len * 0.78, 0.006, satin);
  shaft.position.y = -len * 0.5;
  g.add(shaft);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(len * 0.085, len * 0.03, 8, 20), chrome);
  ring.position.y = -len * 0.06;
  g.add(ring);
  // Open jaw at the bottom: two prongs
  for (const s of [-1, 1]) {
    const prong = cube(len * 0.05, len * 0.13, 0.007, satin);
    prong.position.set(s * len * 0.075, -len * 0.95, 0);
    prong.rotation.z = s * 0.25;
    g.add(prong);
  }
  return g;
}

function adjustable(): THREE.Group {
  const g = new THREE.Group();
  const handle = cube(0.026, 0.19, 0.008, satin);
  handle.position.y = -0.13;
  g.add(handle);
  const grip = cube(0.03, 0.09, 0.011, gripRed);
  grip.position.y = -0.18;
  g.add(grip);
  const head = cyl(0.03, 0.03, 0.012, chrome, 18);
  head.rotation.x = Math.PI / 2;
  head.position.y = -0.02;
  g.add(head);
  const jaw = cube(0.03, 0.03, 0.012, satin);
  jaw.position.set(0.024, 0.0, 0);
  g.add(jaw);
  const worm = cyl(0.007, 0.007, 0.022, steelDark, 10);
  worm.position.set(0.0, -0.045, 0.006);
  g.add(worm);
  return g;
}

function screwdriver(len: number, grip: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const handle = cyl(0.014, 0.012, len * 0.42, grip, 14);
  handle.position.y = -len * 0.21;
  g.add(handle);
  for (const y of [-0.012, -len * 0.4]) {
    const band = cyl(0.0145, 0.0145, 0.008, gripBlack, 14);
    band.position.y = y;
    g.add(band);
  }
  const shaft = cyl(0.0035, 0.0035, len * 0.55, chrome, 8);
  shaft.position.y = -len * 0.42 - len * 0.275;
  g.add(shaft);
  const tip = cube(0.008, 0.012, 0.002, chrome);
  tip.position.y = -len * 0.97 - 0.006;
  g.add(tip);
  return g;
}

function hammer(): THREE.Group {
  const g = new THREE.Group();
  const shaft = cube(0.022, 0.3, 0.016, steelDark);
  shaft.position.y = -0.17;
  g.add(shaft);
  const grip = cyl(0.016, 0.017, 0.12, gripBlack, 12);
  grip.position.y = -0.27;
  g.add(grip);
  const head = cube(0.12, 0.032, 0.03, steelDark);
  head.position.y = -0.01;
  g.add(head);
  const face = cyl(0.017, 0.017, 0.02, chrome, 14);
  face.rotation.z = Math.PI / 2;
  face.position.set(-0.07, -0.01, 0);
  g.add(face);
  // Claw: two tines curling back
  for (const s of [-1, 1]) {
    const tine = cube(0.05, 0.012, 0.009, steelDark);
    tine.position.set(0.075, -0.004, s * 0.008);
    tine.rotation.z = -0.35;
    g.add(tine);
  }
  return g;
}

function pliers(): THREE.Group {
  const g = new THREE.Group();
  for (const s of [-1, 1]) {
    const arm = cube(0.016, 0.15, 0.007, gripRed);
    arm.position.set(s * 0.018, -0.12, s * 0.002);
    arm.rotation.z = s * 0.12;
    g.add(arm);
    const jaw = cube(0.012, 0.06, 0.008, satin);
    jaw.position.set(-s * 0.004, -0.015, s * 0.002);
    jaw.rotation.z = -s * 0.08;
    g.add(jaw);
  }
  const pivot = cyl(0.008, 0.008, 0.02, chrome, 12);
  pivot.rotation.x = Math.PI / 2;
  pivot.position.y = -0.045;
  g.add(pivot);
  return g;
}

function tapeMeasure(): THREE.Group {
  const g = new THREE.Group();
  const body = cyl(0.035, 0.035, 0.035, yellow, 20);
  body.rotation.x = Math.PI / 2;
  body.position.y = -0.04;
  g.add(body);
  const box = cube(0.07, 0.03, 0.035, yellow);
  box.position.y = -0.065;
  g.add(box);
  const hub = cyl(0.014, 0.014, 0.037, gripBlack, 16);
  hub.rotation.x = Math.PI / 2;
  hub.position.y = -0.04;
  g.add(hub);
  const blade = cube(0.008, 0.006, 0.02, chrome);
  blade.position.set(0.038, -0.075, 0);
  g.add(blade);
  return g;
}

function drill(): THREE.Group {
  const g = new THREE.Group();
  // Hung by its handle: motor body horizontal at the top
  const motor = cyl(0.03, 0.028, 0.15, amberPlastic, 18);
  motor.rotation.z = Math.PI / 2;
  motor.position.set(0, -0.03, 0);
  g.add(motor);
  const cap = cyl(0.031, 0.031, 0.02, gripBlack, 18);
  cap.rotation.z = Math.PI / 2;
  cap.position.set(-0.08, -0.03, 0);
  g.add(cap);
  const chuck = cyl(0.016, 0.012, 0.045, gripBlack, 14);
  chuck.rotation.z = Math.PI / 2;
  chuck.position.set(0.095, -0.03, 0);
  g.add(chuck);
  const bit = cyl(0.003, 0.003, 0.05, chrome, 8);
  bit.rotation.z = Math.PI / 2;
  bit.position.set(0.14, -0.03, 0);
  g.add(bit);
  const handle = cube(0.034, 0.12, 0.03, gripBlack);
  handle.position.set(-0.01, -0.11, 0);
  handle.rotation.z = -0.15;
  g.add(handle);
  const trigger = cube(0.012, 0.022, 0.012, gripRed);
  trigger.position.set(0.012, -0.07, 0);
  g.add(trigger);
  const battery = cube(0.07, 0.04, 0.05, steelDark);
  battery.position.set(-0.02, -0.185, 0);
  g.add(battery);
  return g;
}

function cableCoil(): THREE.Group {
  const g = new THREE.Group();
  for (let k = 0; k < 4; k++) {
    const loop = new THREE.Mesh(new THREE.TorusGeometry(0.11 - k * 0.006, 0.008, 6, 28), cableOrange);
    loop.position.set(k * 0.004, -0.11, 0.012 + k * 0.006);
    loop.rotation.y = 0.12 * (k - 1.5);
    g.add(loop);
  }
  const plug = cube(0.03, 0.05, 0.022, gripBlack);
  plug.position.set(0.08, -0.235, 0.03);
  g.add(plug);
  return g;
}

/** A full board of tools; `seed` varies the layout per wall. */
export function buildToolWall(seed: number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'tool-wall';
  const hang = (tool: THREE.Object3D, x: number, y: number, tilt = 0) => {
    g.add(peg(x, y));
    tool.position.set(x, y, 0.035);
    tool.rotation.z = tilt;
    g.add(tool);
  };
  const flip = seed % 2 ? -1 : 1;
  const X = (x: number) => x * flip;
  // Spanners graded by size
  [0.17, 0.2, 0.23, 0.26, 0.29].forEach((len, i) => hang(wrench(len), X(-1.12 + i * 0.075), 0.62));
  hang(adjustable(), X(-0.62), 0.62);
  // Screwdrivers
  [gripRed, amberPlastic, gripRed, gripBlack, amberPlastic].forEach((m, i) => hang(screwdriver(0.17 + (i % 3) * 0.03, m), X(-1.12 + i * 0.06), 0.12));
  hang(hammer(), X(-0.42), 0.6, 0.04);
  hang(pliers(), X(-0.25), 0.6);
  hang(pliers(), X(-0.17), 0.6, -0.05);
  hang(tapeMeasure(), X(0.0), 0.62);
  hang(drill(), X(0.32), 0.6);
  hang(cableCoil(), X(0.85), 0.62);
  hang(drill(), X(0.58), 0.05);
  hang(tapeMeasure(), X(-0.55), 0.05);
  [0.19, 0.22].forEach((len, i) => hang(wrench(len), X(-0.28 + i * 0.07), 0.12));
  return flatten(g);
}

/** Re-parent every mesh straight under the root (transforms baked into
 * the mesh matrices) so the static merge sees them as siblings. */
function flatten(root: THREE.Group): THREE.Group {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  const out = new THREE.Group();
  out.name = root.name;
  for (const m of meshes) {
    const local = m.matrixWorld.clone().premultiply(inv);
    const mesh = new THREE.Mesh(m.geometry, m.material);
    local.decompose(mesh.position, mesh.quaternion, mesh.scale);
    out.add(mesh);
  }
  return out;
}
