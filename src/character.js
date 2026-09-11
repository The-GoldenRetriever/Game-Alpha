import * as THREE from 'three';

// A procedurally animated humanoid built from primitives. Everything is authored in
// metres with the feet at y = 0, so the rig can simply be parked at the player's feet.
//
// Conventions, all local to a joint: limbs hang down -Y, forward is -Z, right is +X.
// Rotating a joint about +X swings a hanging limb forward but tips an upright part
// (torso, head, whole body) backward, so torso/root pitch reads: negative leans
// forward, positive leans back. Head pitch follows the camera: positive looks up.
// `knee`/`elbow` are stored as a positive "bend" and negated on the way in.

export const RIG = {
  height: 1.8,
  hip: 0.95, waist: 1.07, chest: 1.28, shoulder: 1.44, neck: 1.52, head: 1.655,
  shoulderX: 0.185, hipX: 0.095,
  upperArm: 0.29, foreArm: 0.25,
  thigh: 0.46, shin: 0.43,
};

const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;

// Where the aiming eye sits, in body space. The weapon hangs off a pivot here, so
// looking up and down swings the gun around the eye exactly the way a real sight line
// does, and the head is then posed to meet it rather than the other way round.
const EYE = new THREE.Vector3(0.05, 1.6, -0.1);
const ARM_UPPER = RIG.upperArm;
const ARM_LOWER = RIG.foreArm;          // the IK effector is the wrist
const PALM = 0.05;                      // and the grip sits this far past it

// Weapon carry poses, all relative to the eye pivot. `hold` is the gun's sight, so the
// aimed pose is simply "sight straight out in front of the eye".
const CARRY = {
  aim:    { x: 0,     y: 0,     z: -0.26, pitch: 0,     yaw: 0,     roll: 0 },
  ready:  { x: 0.09,  y: -0.22, z: -0.16, pitch: -0.22, yaw: -0.12, roll: 0.1 },
  sprint: { x: 0.17,  y: -0.42, z: -0.08, pitch: -0.95, yaw: 0.45,  roll: 0.2 },
  slide:  { x: 0.12,  y: -0.46, z: -0.22, pitch: -0.15, yaw: -0.35, roll: 0.45 },
  dive:   { x: 0.04,  y: -0.3,  z: -0.42, pitch: 0.1,   yaw: 0,     roll: 0 },
  roll:   { x: 0.12,  y: -0.34, z: -0.04, pitch: -0.6,  yaw: 0.3,   roll: 0.3 },
};

function makeMaterials() {
  return {
    suit: new THREE.MeshStandardMaterial({ color: 0xdfe6ed, roughness: 0.62, metalness: 0.06 }),
    plate: new THREE.MeshStandardMaterial({ color: 0x8d9aa8, roughness: 0.42, metalness: 0.35 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2e3843, roughness: 0.55, metalness: 0.25 }),
    accent: new THREE.MeshStandardMaterial({ color: 0x4fa39d, roughness: 0.4, metalness: 0.2, emissive: 0x10403c, emissiveIntensity: 1 }),
    visor: new THREE.MeshStandardMaterial({ color: 0x123634, roughness: 0.18, metalness: 0.5, emissive: 0x27d2c4, emissiveIntensity: 0.55 }),
  };
}

// `order` matters for shoulders and hips: with 'ZXY' the twist is applied first, about
// the limb's own long axis, then the forward swing, then the abduction. That is what
// lets an elbow point out to the side while the forearm still aims straight ahead.
function joint(parent, x = 0, y = 0, z = 0, order = 'YXZ') {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.order = order;
  parent.add(g);
  return g;
}

// A capsule hanging from its joint, so the joint sits at the top of the segment.
function limb(parent, radius, length, mat) {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(radius, Math.max(length - radius * 2, 0.02), 4, 12), mat);
  m.position.y = -length / 2;
  parent.add(m);
  return m;
}

function ball(parent, radius, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 10), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

// --- two-bone arm IK --------------------------------------------------------
// Solves a shoulder/elbow chain so the hand lands on a point, which is what keeps
// both hands welded to the weapon wherever the weapon happens to be.
const DOWN = new THREE.Vector3(0, -1, 0);
const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _bendAxis = new THREE.Vector3();
const _u = new THREE.Vector3();
const _xa = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'ZXY');
const _ikTarget = new THREE.Vector3();
const _ikAlt = new THREE.Vector3();
const _magPos = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _reach = new THREE.Vector3();
const _span = new THREE.Vector3();
const _slid = new THREE.Vector3();

// How far along `from` -> `to` the hand has to slide before the shoulder can reach it.
// Returns 0 when the original point is already in range.
function reachFraction(shoulder, from, to) {
  const R = ARM_UPPER + ARM_LOWER - 0.012;
  _reach.copy(from).sub(shoulder);
  if (_reach.lengthSq() <= R * R) return 0;
  _span.copy(to).sub(from);
  const a = _span.lengthSq();
  if (a < 1e-8) return 1;
  const b = 2 * _reach.dot(_span);
  const c = _reach.lengthSq() - R * R;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return 1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return clamp(t, 0, 1);
}
const _ikOut = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _gunQuat = new THREE.Quaternion();
const _armQuat = new THREE.Quaternion();
const _handQuat = new THREE.Quaternion();
const _wrist = new THREE.Vector3();
const _palm = new THREE.Vector3();
// How each hand sits on the weapon. The firing hand wraps the pistol grip; the support
// hand comes onto the handguard at an angle.
const GRIP_R = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, 0, 0.1));
const GRIP_L = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.6, 0, -0.2));

// `target` and `shoulderPos` are both in the shoulder's parent space. `pole` is the
// direction the elbow should break towards. Fills `out` with the shoulder's ZXY Euler
// and returns the elbow bend.
function solveArm(shoulderPos, target, pole, out) {
  _v.copy(target).sub(shoulderPos);
  let d = _v.length();
  if (d < 1e-4) { _v.set(0, -0.1, 0); d = 0.1; }
  _dir.copy(_v).divideScalar(d);

  const A = ARM_UPPER, B = ARM_LOWER;
  d = clamp(d, Math.abs(A - B) + 0.02, A + B - 0.008);
  const bend = Math.PI - Math.acos(clamp((A * A + B * B - d * d) / (2 * A * B), -1, 1));
  const alpha = Math.acos(clamp((A * A + d * d - B * B) / (2 * A * d), -1, 1));

  // Swing the upper arm off the straight line, towards the pole.
  _axis.crossVectors(_dir, pole);
  if (_axis.lengthSq() < 1e-8) _axis.set(1, 0, 0); else _axis.normalize();
  _u.copy(_dir).applyAxisAngle(_axis, -alpha);

  _q1.setFromUnitVectors(DOWN, _u);
  // Then twist about the upper arm so the elbow hinge lies in the bend plane.
  _bendAxis.crossVectors(_u, _dir);
  if (_bendAxis.lengthSq() < 1e-8) _bendAxis.copy(_axis); else _bendAxis.normalize();
  _xa.set(1, 0, 0).applyQuaternion(_q1);
  const phi = Math.atan2(_cross.crossVectors(_xa, _bendAxis).dot(_u), _xa.dot(_bendAxis));
  _q2.setFromAxisAngle(_u, phi);
  _q1.premultiply(_q2);

  _euler.setFromQuaternion(_q1, 'ZXY');
  out.set(_euler.x, _euler.y, _euler.z);
  return bend;
}

function slab(parent, sx, sy, sz, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

// --- pose channels ----------------------------------------------------------
// Every channel is a plain number so the whole pose can be blended generically.
const REST = {
  rootY: 0, rootPitch: 0, rootRoll: 0,
  hipY: 0, hipPitch: 0, hipYaw: 0, hipRoll: 0,
  torsoPitch: 0, torsoYaw: 0, torsoRoll: 0,
  headPitch: 0, headYaw: 0, headRoll: 0,
  holdX: CARRY.ready.x, holdY: CARRY.ready.y, holdZ: CARRY.ready.z,
  holdPitch: CARRY.ready.pitch, holdYaw: CARRY.ready.yaw, holdRoll: CARRY.ready.roll,
  armLPitch: 0.05, armLSide: 0.09, armLTwist: 0, elbowL: 0.18,
  armRPitch: 0.05, armRSide: 0.09, armRTwist: 0, elbowR: 0.18,
  legLPitch: 0, legLSide: 0.015, kneeL: 0.04, ankleL: 0,
  legRPitch: 0, legRSide: 0.015, kneeR: 0.04, ankleR: 0,
};

// Per-channel blend rates. Limbs chase fast enough to keep a run cycle crisp; the
// body core is slower so state changes read as weight shifting rather than snapping.
const RATE = {
  rootY: 13, rootPitch: 13, rootRoll: 11,
  hipY: 16, hipPitch: 13, hipYaw: 16, hipRoll: 13,
  torsoPitch: 12, torsoYaw: 14, torsoRoll: 12,
  headPitch: 16, headYaw: 16, headRoll: 12,
  holdX: 15, holdY: 15, holdZ: 15, holdPitch: 15, holdYaw: 15, holdRoll: 15,
  default: 19,
};

export class Character {
  constructor() {
    this.mat = makeMaterials();
    this.pose = { ...REST };
    this.target = { ...REST };
    this.phase = 0;
    this.breath = 0;
    this.build();
  }

  build() {
    const R = RIG, M = this.mat;

    this.root = new THREE.Group();          // sits at the player's feet, yawed to face travel
    this.root.rotation.order = 'YXZ';
    // Dives, slides and the landing flip all rotate about the hips. `rootY` rides on
    // the pivot itself rather than inside it, so banking the body over never lifts it
    // off the floor.
    this.pivot = joint(this.root, 0, R.hip);
    this.frame = joint(this.pivot, 0, -R.hip);

    // --- hips -------------------------------------------------------------
    this.hips = joint(this.frame, 0, R.hip);
    slab(this.hips, 0.30, 0.19, 0.21, M.plate, 0, -0.04, 0);
    ball(this.hips, 0.115, M.suit, 0, 0.02, 0).scale.set(1.15, 0.85, 0.95);
    slab(this.hips, 0.075, 0.10, 0.055, M.accent, 0.165, -0.05, 0.02);   // hip pouch

    // --- legs -------------------------------------------------------------
    this.legs = [];
    for (const side of [-1, 1]) {
      const hipJ = joint(this.hips, side * R.hipX, 0, 0, 'ZXY');
      ball(hipJ, 0.095, M.suit);
      limb(hipJ, 0.083, R.thigh, M.suit);
      slab(hipJ, 0.13, 0.16, 0.13, M.plate, 0, -0.2, -0.015);            // thigh plate
      const kneeJ = joint(hipJ, 0, -R.thigh, 0);
      ball(kneeJ, 0.077, M.plate);
      limb(kneeJ, 0.068, R.shin, M.suit);
      slab(kneeJ, 0.115, 0.20, 0.10, M.plate, 0, -0.13, -0.02);          // shin guard
      const ankleJ = joint(kneeJ, 0, -R.shin, 0);
      ball(ankleJ, 0.055, M.dark);
      slab(ankleJ, 0.115, 0.075, 0.27, M.dark, 0, -0.028, -0.05);        // boot
      slab(ankleJ, 0.095, 0.035, 0.10, M.plate, 0, 0.012, -0.13);        // toe cap
      this.legs.push({ hip: hipJ, knee: kneeJ, ankle: ankleJ, side });
    }

    // --- torso ------------------------------------------------------------
    this.torso = joint(this.hips, 0, 0, 0);
    const abdomen = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.125, R.waist - R.hip + 0.06, 12), M.suit);
    abdomen.position.y = (R.waist - R.hip) / 2 + 0.02;
    abdomen.scale.z = 0.82;
    this.torso.add(abdomen);
    const chest = new THREE.Mesh(new THREE.CylinderGeometry(0.195, 0.16, R.chest - R.waist + 0.13, 12), M.suit);
    chest.position.y = (R.chest - R.hip + R.waist - R.hip) / 2 + 0.02;
    chest.scale.z = 0.8;
    this.torso.add(chest);
    slab(this.torso, 0.30, 0.26, 0.13, M.plate, 0, R.chest - R.hip - 0.07, -0.095);  // chest plate
    slab(this.torso, 0.26, 0.30, 0.12, M.dark, 0, R.chest - R.hip - 0.09, 0.10);     // backpack
    slab(this.torso, 0.085, 0.055, 0.035, M.accent, 0, R.chest - R.hip - 0.02, -0.16); // chest light

    // --- head -------------------------------------------------------------
    this.neck = joint(this.torso, 0, R.neck - R.hip - 0.06, 0);
    const neckMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.07, 0.11, 8), M.dark);
    neckMesh.position.y = 0.03;
    this.neck.add(neckMesh);
    this.head = joint(this.neck, 0, 0.09, 0);
    const skull = ball(this.head, 0.118, M.suit, 0, 0.035, 0.008);
    skull.scale.set(1, 1.06, 1.1);
    slab(this.head, 0.175, 0.085, 0.075, M.visor, 0, 0.03, -0.085);      // visor
    slab(this.head, 0.055, 0.10, 0.13, M.plate, 0.105, 0.04, 0.01);      // ear pods
    slab(this.head, 0.055, 0.10, 0.13, M.plate, -0.105, 0.04, 0.01);
    slab(this.head, 0.03, 0.05, 0.16, M.accent, 0, 0.135, 0.02);         // crest

    // --- arms -------------------------------------------------------------
    this.arms = [];
    for (const side of [-1, 1]) {
      const shoulderJ = joint(this.torso, side * RIG.shoulderX, RIG.shoulder - RIG.hip, 0, 'ZXY');
      ball(shoulderJ, 0.092, M.plate).scale.set(1.05, 0.95, 1);
      limb(shoulderJ, 0.056, RIG.upperArm, M.suit);
      const elbowJ = joint(shoulderJ, 0, -RIG.upperArm, 0);
      ball(elbowJ, 0.052, M.plate);
      limb(elbowJ, 0.049, RIG.foreArm, M.suit);
      slab(elbowJ, 0.085, 0.13, 0.085, M.plate, 0, -0.075, -0.005);      // forearm guard
      const handJ = joint(elbowJ, 0, -RIG.foreArm, 0);
      slab(handJ, 0.075, 0.10, 0.062, M.dark, 0, -0.045, -0.005);        // hand
      this.arms.push({ shoulder: shoulderJ, elbow: elbowJ, hand: handJ, side });
    }
    this.handL = this.arms[0].hand;
    this.handR = this.arms[1].hand;

    // The weapon rides here, not in the hand: the hands are solved onto it instead.
    this.aimPivot = joint(this.frame, EYE.x, EYE.y, EYE.z);
    this.hold = joint(this.aimPivot, 0, 0, 0);
    this.hold.rotation.order = 'YXZ';

    this.root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  }

  // Hang a weapon off the aim pivot, lined up so its sight sits on the eye line.
  attachWeapon(gun) {
    this.gun = gun;
    this.gunAnchors = {
      grip: gun.getObjectByName('grip'),
      foregrip: gun.getObjectByName('foregrip'),
      magwell: gun.getObjectByName('magwell'),
    };
    const sight = gun.getObjectByName('sight');
    gun.position.set(-sight.position.x, -sight.position.y, -sight.position.z);
    gun.rotation.set(0, 0, 0);
    this.hold.add(gun);
    return gun;
  }

  setVisibleToCamera(visible) {
    this.root.visible = visible;
  }

  // ---------------------------------------------------------------------------
  // `s` is the animation state handed over by the player each frame.
  update(dt, s) {
    const T = Object.assign(this.target, REST);
    const sp = s.speed;
    const gait = clamp(sp / 6.4, 0, 1.3);
    this.gait = gait;
    // How much the support hand is on the gun: full while aiming, firing, charging or
    // reloading, released at a sprint so the free arm can pump.
    const sprint = clamp((sp - 3.6) / 3.2, 0, 1);
    this.sprint = sprint;
    this.grip = clamp(Math.max(s.aiming, s.fireHold, s.charge, s.reload >= 0 ? 1 : 0, 1 - sprint), 0, 1);

    // Cadence rises with speed; the cycle keeps running a moment after you stop so
    // the legs settle instead of freezing mid-stride.
    const cadence = 0.55 + sp * 0.17;
    if (sp > 0.25 || s.mode === 'move') this.phase = (this.phase + dt * cadence * TAU) % TAU;
    this.breath = (this.breath + dt * 1.1) % TAU;

    switch (s.mode) {
      case 'slide': this.poseSlide(T, s); break;
      case 'dive':  this.poseDive(T, s); break;
      case 'roll':  this.poseRoll(T, s); break;
      case 'air':   this.poseAir(T, s); break;
      case 'move':  this.poseRun(T, s, gait); break;
      default:      this.poseIdle(T, s); break;
    }

    // The gun arm only tracks the camera while upright — slides and dives pose it
    // themselves.
    const upright = s.mode === 'move' || s.mode === 'idle' || s.mode === 'air';
    if (upright) this.poseAim(T, s);
    const grounded = s.mode === 'move' || s.mode === 'idle' || s.mode === 'slide';
    this.poseCarry(T, s, upright);

    // Landing squat: a short dip in the hips right after touching down.
    if (s.landing > 0) {
      const dip = s.landing * 0.26;
      T.rootY -= dip;
      T.kneeL += dip * 3.4; T.kneeR += dip * 3.4;
      T.legLPitch += dip * 1.1; T.legRPitch += dip * 1.1;
      T.torsoPitch += -dip * 1.5;
    }

    // Lean into strafes and into hard camera turns.
    T.rootRoll += clamp(s.moveR * 0.16 - s.turn * 0.1, -0.3, 0.3) * (grounded ? 1 : 0.5);

    this.blend(dt);
    this.apply(s);

    // Hands last: the weapon is placed off the finished body pose, then the arms are
    // solved onto it, so both hands sit on the gun instead of near it.
    this.root.updateMatrixWorld(true);
    this.placeWeapon(s);
    this.solveHands(s);
  }

  // Where the weapon is carried, and how tightly it is held. `grip` is how much the
  // support hand is on the gun: full while aiming, firing, charging or reloading, and
  // released at a sprint so the free arm can pump.
  poseCarry(T, s, upright) {
    const sprint = this.sprint;
    const reloading = s.reload >= 0;

    let pose = CARRY.ready;
    if (s.mode === 'slide') pose = CARRY.slide;
    else if (s.mode === 'dive') pose = CARRY.dive;
    else if (s.mode === 'roll') pose = CARRY.roll;
    else if (upright) {
      // Blend ready -> aimed with ADS, and ready -> sprint carry with speed.
      const a = s.aiming;
      // The sprint carry only takes over when the support hand is actually free, so
      // firing or aiming on the move brings the weapon straight back up.
      const k = sprint * (1 - this.grip);
      pose = {
        x: lerp(lerp(CARRY.ready.x, CARRY.aim.x, a), CARRY.sprint.x, k),
        y: lerp(lerp(CARRY.ready.y, CARRY.aim.y, a), CARRY.sprint.y, k),
        z: lerp(lerp(CARRY.ready.z, CARRY.aim.z, a), CARRY.sprint.z, k),
        pitch: lerp(lerp(CARRY.ready.pitch, CARRY.aim.pitch, a), CARRY.sprint.pitch, k),
        yaw: lerp(lerp(CARRY.ready.yaw, CARRY.aim.yaw, a), CARRY.sprint.yaw, k),
        roll: lerp(lerp(CARRY.ready.roll, CARRY.aim.roll, a), CARRY.sprint.roll, k),
      };
    }

    T.holdX = pose.x; T.holdY = pose.y; T.holdZ = pose.z;
    T.holdPitch = pose.pitch; T.holdYaw = pose.yaw; T.holdRoll = pose.roll;

    // Reload: the gun comes inboard and tips up so the magazine well is reachable.
    if (reloading) {
      const swing = Math.sin(clamp(s.reload, 0, 1) * Math.PI);
      T.holdX += 0.02 * swing;
      T.holdY += -0.1 * swing;
      T.holdZ += 0.07 * swing;
      T.holdRoll += 0.75 * swing;
      T.holdPitch += -0.15 * swing;
    }

    // Charging braces the weapon in tight against the shoulder.
    if (s.charge > 0) {
      T.holdZ += 0.03 * s.charge;
      T.holdPitch += 0.04 * s.charge;
    }

    // Recoil throws the muzzle up and the weapon back into the shoulder.
    const k = s.recoil * s.recoil;
    T.holdZ += k * 0.06;
    T.holdPitch += k * 0.32;
    T.holdY += k * 0.015;
  }

  // Push the blended carry channels into the weapon's transform.
  placeWeapon(s) {
    const p = this.pose;
    // While aiming, hang the sight line off the head's actual eye rather than a fixed
    // point, so the sight stays lined up however far the neck has pitched.
    _eye.set(0.045, 0.035, -0.1);
    this.head.localToWorld(_eye);
    this.frame.worldToLocal(_eye);
    this.aimPivot.position.lerpVectors(EYE, _eye, s.aiming);

    // The pivot carries the aim pitch: while aimed it is the full look angle, and it
    // relaxes towards a loose follow when the gun is down.
    this.aimPivot.rotation.x = s.aimPitch * lerp(0.35, 1, s.aiming);
    this.hold.position.set(p.holdX, p.holdY, p.holdZ);
    this.hold.rotation.set(p.holdPitch, p.holdYaw, p.holdRoll);

    if (this.gun) {
      const mag = this.gun.userData.magazine;
      if (mag) {
        // Drop the magazine out over the middle of the reload.
        const r = s.reload;
        const out = r < 0 ? 0 : clamp(Math.sin(clamp((r - 0.08) / 0.55, 0, 1) * Math.PI), 0, 1);
        mag.position.y = -0.055 - out * 0.3;
        mag.visible = out < 0.95;
      }
    }
    this.aimPivot.updateMatrixWorld(true);
  }

  poseIdle(T, s) {
    const b = Math.sin(this.breath);
    const shift = Math.sin(this.breath * 0.45);
    T.rootY += b * 0.006;
    T.torsoPitch += -0.04 + b * 0.022;
    T.torsoRoll += shift * 0.035;
    T.hipRoll += shift * 0.045;
    T.hipY += b * 0.004;
    T.headPitch += b * 0.02;
    T.headYaw += shift * 0.06;
    T.armLPitch += b * 0.035; T.armRPitch += b * 0.03;
    T.armLSide += 0.03; T.armRSide += 0.03;
    T.kneeL += 0.06 + shift * 0.03; T.kneeR += 0.06 - shift * 0.03;
  }

  poseRun(T, s, gait) {
    const p = this.phase;
    const sw = Math.sin(p), sw2 = Math.sin(p * 2);
    // The body faces wherever the gun is pointed, so the cycle has to cope with
    // running sideways and backwards: `fwd` signs the stride, `side` turns it into a
    // sidestep.
    const fwd = s.moveF, side = s.moveR;
    const amp = (0.28 + gait * 0.30) * fwd;      // negative when backpedalling
    const kneeAmp = 0.9 + gait * 0.95;
    // A leg is in swing while cos of its own phase is positive, so one knee folds up
    // while the other stays straight underneath the body.
    const fold = (x) => Math.pow(Math.max(0, x), 1.3);

    const thighL = amp * sw, thighR = -amp * sw;
    const kneeL = 0.08 + kneeAmp * fold(Math.cos(p));
    const kneeR = 0.08 + kneeAmp * fold(-Math.cos(p));
    T.legLPitch += thighL;
    T.legRPitch += thighR;
    T.kneeL += kneeL;
    T.kneeR += kneeR;
    // The ankle mostly cancels the shin's tilt, so the sole stays parallel to the
    // ground instead of driving a toe or a heel through it.
    T.ankleL += -(thighL - kneeL) * 0.85;
    T.ankleR += -(thighR - kneeR) * 0.85;
    // Sidestep: both legs swing the same way in world space, alternating with the
    // stride, plus a little permanent splay so the stance stays wide.
    const step = side * 0.3 * sw;
    T.legLSide += 0.02 * gait - step + Math.abs(side) * 0.05;
    T.legRSide += 0.02 * gait + step + Math.abs(side) * 0.05;

    // The pelvis rides the straight stance leg: drop exactly as much as that leg
    // shortens when it swings away from vertical, and the planted foot never sinks
    // into the floor or hovers over it.
    T.rootY += -(RIG.thigh + RIG.shin) * (1 - Math.cos(amp * sw));

    // Hips counter-rotate against the shoulders, once per stride each way.
    T.hipY += sw2 * 0.012 * gait;
    T.hipYaw += -0.14 * gait * sw * fwd;
    T.hipRoll += 0.07 * gait * Math.cos(p);
    T.torsoPitch += -(0.08 + gait * 0.26) * fwd;   // leans back when backing up
    T.torsoYaw += 0.2 * gait * sw * fwd;
    T.torsoRoll += -0.05 * gait * Math.cos(p);
    T.headPitch += gait * 0.16 * fwd + sw2 * 0.02;
    T.headYaw += -0.1 * gait * sw * fwd;

    // The free arm only pumps when it is not on the weapon.
    const free = 1 - this.grip;
    const pump = (0.5 + gait * 0.75) * free;
    T.armLPitch += -amp * sw * pump * 1.4;
    T.armLSide += 0.06 * gait * free;
    T.elbowL += (0.5 + gait * 0.55 + Math.max(0, -sw) * 0.5) * free;
  }

  poseAir(T, s) {
    // Blend from a tucked launch pose into a spread, braced falling pose.
    const rise = clamp(s.velY / 7, -1, 1);
    const up = Math.max(0, rise), down = Math.max(0, -rise);

    T.torsoPitch += 0.16 * up - 0.14 * down;
    T.hipPitch += 0.1 * up;

    T.legLPitch += 0.55 * up - 0.22 * down;
    T.legRPitch += 0.18 * up + 0.3 * down;
    T.kneeL += 0.35 + 1.15 * up + 0.25 * down;
    T.kneeR += 0.3 + 0.55 * up + 0.5 * down;
    T.legLSide += 0.1 * down; T.legRSide += 0.14 * down;
    T.ankleL += -0.25; T.ankleR += -0.3 * down;

    T.armLPitch += -0.5 * up - 0.15 * down;
    T.armLSide += 0.45 + 0.35 * down;
    T.elbowL += 0.9 + 0.5 * down;
    T.armRSide += 0.12 * down;
    T.armRPitch += -0.1 * up;
    T.headPitch += -0.1 * down;
  }

  // Sideways slide: the body banks over onto one hip with the lead leg thrown out
  // ahead and the trailing leg folded under it.
  poseSlide(T, s) {
    const lean = s.slideLean;            // +1 slides onto the right hip, -1 the left
    const settle = clamp(s.stateT * 4, 0, 1);
    const wob = Math.sin(s.stateT * 11) * 0.05 * (1 - settle);

    T.rootY += -0.60 * settle;
    T.rootRoll += (1.0 + wob) * lean * settle;
    T.rootPitch += 0.34 * settle;              // reclined, feet first
    T.hipYaw += -0.28 * lean * settle;

    const lead = lean > 0 ? 'L' : 'R';   // the outstretched leg
    const trail = lean > 0 ? 'R' : 'L';
    T[`leg${lead}Pitch`] += 0.92 * settle;
    T[`knee${lead}`] += 0.16;
    T[`ankle${lead}`] += 0.42 * settle;
    T[`leg${lead}Side`] += -0.12 * lean * settle;
    T[`leg${trail}Pitch`] += 0.55 * settle;
    T[`knee${trail}`] += 1.65 * settle;
    T[`leg${trail}Side`] += 0.34 * lean * settle;

    T.torsoPitch += 0.26 * settle;
    T.torsoYaw += 0.42 * lean * settle;
    T.torsoRoll += -0.34 * lean * settle;
    T.headRoll += -0.85 * lean * settle;
    T.headYaw += -0.3 * lean * settle;
    T.headPitch += -0.42 * settle;             // chin down to keep looking down the lane

    // Trailing arm reaches back to the floor, gun arm tucks across the chest.
    const brace = lean > 0 ? 'R' : 'L';
    const gunArm = 'R';
    T[`arm${brace}Pitch`] += -0.85 * settle;
    T[`arm${brace}Side`] += 0.55 * settle;
    T[`elbow${brace}`] += 0.35;
    T[`arm${gunArm}Pitch`] += 0.5 * settle;
    T[`elbow${gunArm}`] += 1.5 * settle;
    T.armLSide += 0.2 * settle;
  }

  // Air slide: a flat superman dive, gun punched out ahead.
  poseDive(T, s) {
    const t = clamp(s.stateT * 5, 0, 1);
    // The forward pitch itself rides on `s.flip`, which the player drives straight
    // through into the landing flip without ever being smoothed twice.
    T.rootY += -0.42 * t;
    T.rootRoll += 0.12 * s.slideLean * t;

    T.torsoPitch += -0.3 * t;
    T.headPitch += 0.95 * t;             // keep the eyes on the horizon
    T.hipPitch += 0.22 * t;

    const kick = Math.sin(s.stateT * 7);
    T.legLPitch += -0.3 * t + kick * 0.18;
    T.legRPitch += -0.22 * t - kick * 0.18;
    T.kneeL += 0.3 + Math.max(0, kick) * 0.7;
    T.kneeR += 0.3 + Math.max(0, -kick) * 0.7;
    T.legLSide += 0.16 * t; T.legRSide += 0.16 * t;
    T.ankleL += -0.45 * t; T.ankleR += -0.45 * t;

    T.armLPitch += -1.55 * t; T.armLSide += 0.3 * t; T.elbowL += 0.55 * t;
    T.armRPitch += -1.45 * t; T.armRSide += 0.18 * t; T.elbowR += 0.4 * t;
  }

  // The landing flip. `s.flip` carries the continuous rotation; this is the tuck.
  poseRoll(T, s) {
    const t = clamp(s.stateT, 0, 1);     // 0..1 across the flip
    // The tuck peaks early: the body is already inverted a fifth of the way in, and a
    // loose tuck at that point drags a shoulder through the floor.
    const tuck = Math.sin(Math.pow(t, 0.6) * Math.PI);
    const out = clamp((t - 0.62) / 0.38, 0, 1);

    T.rootY += -0.40 * (1 - out) + tuck * 0.18;   // arcs up over the tuck, back to standing
    T.hipY += -0.05 * tuck;

    T.legLPitch += 1.75 * tuck - out * 0.35;
    T.legRPitch += 1.55 * tuck - out * 0.1;
    T.kneeL += 2.1 * tuck + 0.3;
    T.kneeR += 1.95 * tuck + 0.3;
    T.legLSide += 0.12 * tuck; T.legRSide += 0.12 * tuck;
    T.ankleL += 0.35 * tuck; T.ankleR += 0.35 * tuck;

    T.torsoPitch += -1.2 * tuck;               // chest curls onto the knees
    T.hipPitch += -0.25 * tuck;
    T.headPitch += -0.55 * tuck;         // chin tucked to the chest
    T.armLPitch += 1.1 * tuck; T.armLSide += 0.42 * tuck; T.elbowL += 2.0 * tuck;
    T.armRPitch += 0.95 * tuck; T.armRSide += 0.3 * tuck; T.elbowR += 1.9 * tuck;
  }

  // The upper body behind the gun. The arms themselves are solved onto the weapon
  // afterwards, so this is about the spine, the shoulders and getting the eye behind
  // the sight when aiming.
  poseAim(T, s) {
    const w = s.aiming;
    const pitch = s.aimPitch;

    // Bladed towards the target, weight forward, head coming down onto the stock.
    T.torsoYaw += lerp(-0.06, -0.26, w);
    T.torsoPitch = lerp(T.torsoPitch, -0.16 + pitch * 0.35, w);
    T.torsoRoll = lerp(T.torsoRoll, 0.05, w);
    T.hipYaw += lerp(0, 0.1, w);
    T.headPitch = lerp(T.headPitch, pitch * 0.7, w);  // eye runs down the sight line
    T.headYaw = lerp(T.headYaw, -0.04, w);
    T.headRoll = lerp(T.headRoll, 0.14, w);          // cheek onto the stock
    T.rootY += -0.05 * w;                            // settle into the stance
    T.kneeL += 0.12 * w; T.kneeR += 0.12 * w;

    // Charging braces the whole body back against the wind-up.
    const c = s.charge;
    T.torsoPitch += c * 0.1;
    T.rootY += -0.03 * c;
    T.headPitch += -c * 0.06;

    // Reload: eyes flick down to the magazine well.
    if (s.reload >= 0) {
      const swing = Math.sin(clamp(s.reload, 0, 1) * Math.PI);
      T.headPitch += -0.3 * swing;
      T.headYaw += 0.12 * swing;
      T.torsoPitch += -0.08 * swing;
    }

    // Recoil: the whole upper body absorbs the kick.
    const k = s.recoil;
    T.torsoPitch += k * 0.18;
    T.headPitch += k * 0.14;
    T.rootY += -k * 0.02;
  }

  // Solve both arms onto the weapon. The firing hand is always on the grip; the
  // support hand blends between the gun and whatever the body pose wanted.
  solveHands(s) {
    if (!this.gun) return;
    const p = this.pose;
    const [armL, armR] = this.arms;
    this.gun.getWorldQuaternion(_gunQuat);

    // The hand grips the weapon a palm's width past the wrist, so the chain is solved
    // to the wrist that puts the palm on the anchor with the hand already turned to
    // match the gun.
    const wristFor = (anchorPos, gripOffset) => {
      _handQuat.copy(_gunQuat).multiply(gripOffset);
      _palm.set(0, PALM, 0).applyQuaternion(_handQuat);
      _wrist.copy(anchorPos).add(_palm);
      return this.torso.worldToLocal(_wrist);
    };
    const setWrist = (arm, gripOffset, w) => {
      if (w <= 0.001) { arm.hand.quaternion.identity(); return; }
      arm.elbow.updateMatrixWorld(true);
      arm.elbow.getWorldQuaternion(_armQuat);
      _handQuat.copy(_armQuat).invert().multiply(_gunQuat).multiply(gripOffset);
      arm.hand.quaternion.identity().slerp(_handQuat, w);
    };

    // Firing hand, always on the pistol grip.
    this.gunAnchors.grip.getWorldPosition(_ikAlt);
    _ikTarget.copy(wristFor(_ikAlt, GRIP_R));
    const bendR = solveArm(armR.shoulder.position, _ikTarget, _pole.set(0.85, -0.55, 0.35), _ikOut);
    p.armRPitch = _ikOut.x; p.armRTwist = -_ikOut.y; p.armRSide = _ikOut.z;
    p.elbowR = bendR;

    // Support hand: the handguard normally, the magazine well mid-reload.
    this.gunAnchors.foregrip.getWorldPosition(_ikAlt);
    if (s.reload >= 0) {
      const r = clamp(s.reload, 0, 1);
      const swap = Math.sin(clamp((r - 0.05) / 0.75, 0, 1) * Math.PI);
      this.gunAnchors.magwell.getWorldPosition(_magPos);
      _magPos.y -= 0.14 * (1 - swap);          // dips to the pouch before coming up
      _ikAlt.lerp(_magPos, swap);
    }
    _ikTarget.copy(wristFor(_ikAlt, GRIP_L));
    // If the pose has thrown the weapon out of the support arm's reach, slide that
    // hand back down the handguard towards the grip instead of letting it float.
    this.gunAnchors.grip.getWorldPosition(_magPos);
    _slid.copy(wristFor(_magPos, GRIP_L));
    const t = reachFraction(armL.shoulder.position, _ikTarget, _slid);
    if (t > 0) _ikTarget.lerp(_slid, t);
    const bendL = solveArm(armL.shoulder.position, _ikTarget, _pole.set(-0.55, -1, 0.15), _ikOut);
    const g = this.grip;
    p.armLPitch = lerp(p.armLPitch, _ikOut.x, g);
    p.armLTwist = lerp(p.armLTwist, _ikOut.y, g);
    p.armLSide = lerp(p.armLSide, -_ikOut.z, g);
    p.elbowL = lerp(p.elbowL, bendL, g);

    armL.shoulder.rotation.set(p.armLPitch, p.armLTwist, -p.armLSide);
    armL.elbow.rotation.x = p.elbowL;
    armR.shoulder.rotation.set(p.armRPitch, -p.armRTwist, p.armRSide);
    armR.elbow.rotation.x = p.elbowR;

    setWrist(armR, GRIP_R, 1);
    setWrist(armL, GRIP_L, g);
  }

  blend(dt) {
    const p = this.pose, t = this.target;
    for (const key in p) {
      const rate = RATE[key] || RATE.default;
      p[key] += (t[key] - p[key]) * (1 - Math.exp(-rate * dt));
    }
  }

  apply(s) {
    const p = this.pose;
    this.root.position.set(s.x, s.feetY, s.z);
    this.root.rotation.y = s.bodyYaw;

    // `flip` is fed in raw so a full 360° roll never gets smoothed into a wobble.
    this.pivot.position.y = RIG.hip + p.rootY;
    this.pivot.rotation.set(p.rootPitch + s.flip, 0, p.rootRoll);

    this.hips.position.y = RIG.hip + p.hipY;
    this.hips.rotation.set(p.hipPitch, p.hipYaw, p.hipRoll);
    this.torso.rotation.set(p.torsoPitch, p.torsoYaw, p.torsoRoll);
    this.head.rotation.set(p.headPitch, p.headYaw, p.headRoll);

    const [armL, armR] = this.arms;
    armL.shoulder.rotation.set(p.armLPitch, p.armLTwist, -p.armLSide);
    armL.elbow.rotation.x = p.elbowL;
    armR.shoulder.rotation.set(p.armRPitch, -p.armRTwist, p.armRSide);
    armR.elbow.rotation.x = p.elbowR;

    const [legL, legR] = this.legs;
    legL.hip.rotation.set(p.legLPitch, 0, -p.legLSide);
    legL.knee.rotation.x = -p.kneeL;
    legL.ankle.rotation.x = p.ankleL;
    legR.hip.rotation.set(p.legRPitch, 0, p.legRSide);
    legR.knee.rotation.x = -p.kneeR;
    legR.ankle.rotation.x = p.ankleR;
  }
}
