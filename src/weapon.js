import * as THREE from 'three';
import { traceShot } from './physics.js';
import { MuzzleFlash, LaserSight } from './effects.js';

// A compact carbine. The same model is used twice: once parented to the character's
// right hand for third person, once as a view-locked first-person viewmodel.
//
// Local frame: the barrel runs down -Z, the origin sits in the palm at the grip.
//
// The gun is semi-automatic: one round per press, and the press is ignored until the
// cooldown has run out. Every control has a keyboard twin so the whole weapon can be
// worked from a trackpad, where holding a right-click while steering is not possible.
//
// Reverse aim (F) mirrors the shot line through the camera without touching the view:
// the character turns round and fires over its shoulder while you keep looking ahead.
// Since a charged shot throws you away from the muzzle, that dashes you straight
// forward — the whole point of the control.

const RANGE = 220;
const COOLDOWN = 0.36;          // seconds between shots
const MAG_SIZE = 10;
const RELOAD_TIME = 1.2;

// Keep holding after a shot and the gun starts winding up a charged round, which
// throws you hard the other way. The wind-up only begins well after the shot has
// left, so a normal press never shows the meter at all.
const CHARGE_DELAY = 0.34;
const CHARGE_TIME = 0.52;
const CHARGE_MIN = 0.15;        // release below this and it was just a held trigger
const DASH_MIN = 11;
const DASH_MAX = 25;

// Firing steeply downward kicks you into the air. `BOOST_FLOOR` is how far below the
// horizon you have to be aiming before any of it applies.
const BOOST_FLOOR = 0.4;
const BOOST_IMPULSE = 9.6;
const BOOST_CEILING = 11.5;     // caps how high repeat boosts can stack
const BOOST_PUSH = 0.45;        // share of the impulse that pushes you back level

function gunMaterials() {
  return {
    body: new THREE.MeshStandardMaterial({ color: 0x36414d, roughness: 0.45, metalness: 0.55 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x8f9aa5, roughness: 0.32, metalness: 0.75 }),
    grip: new THREE.MeshStandardMaterial({ color: 0x222a33, roughness: 0.8, metalness: 0.1 }),
    accent: new THREE.MeshStandardMaterial({ color: 0x2f7f79, roughness: 0.35, metalness: 0.3, emissive: 0x1c6f68, emissiveIntensity: 0.9 }),
    glass: new THREE.MeshBasicMaterial({ color: 0x63ffe0, transparent: true, opacity: 0.35, depthWrite: false }),
  };
}

export function buildGun() {
  const M = gunMaterials();
  const g = new THREE.Group();

  const part = (geo, mat, x, y, z, rx = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    g.add(m);
    return m;
  };
  const boxOf = (sx, sy, sz) => new THREE.BoxGeometry(sx, sy, sz);
  const tube = (r, len) => new THREE.CylinderGeometry(r, r, len, 12).rotateX(Math.PI / 2);

  part(boxOf(0.068, 0.105, 0.30), M.body, 0, 0.025, -0.07);          // receiver
  part(boxOf(0.074, 0.03, 0.12), M.metal, 0, 0.082, -0.02);          // top rail
  part(boxOf(0.052, 0.155, 0.072), M.grip, 0, -0.075, 0.028, -0.24); // pistol grip
  const magazine = part(boxOf(0.044, 0.17, 0.08), M.body, 0, -0.055, -0.115, 0.12);
  part(boxOf(0.05, 0.09, 0.19), M.body, 0, 0.035, 0.145);            // stock
  part(boxOf(0.042, 0.045, 0.1), M.grip, 0, 0.085, 0.16);            // cheek riser
  part(boxOf(0.062, 0.066, 0.19), M.body, 0, 0.042, -0.27);          // handguard
  part(boxOf(0.03, 0.05, 0.11), M.grip, 0, -0.02, -0.29, 0.35);      // angled foregrip
  part(tube(0.016, 0.2), M.metal, 0, 0.045, -0.4);                   // barrel
  part(tube(0.027, 0.06), M.metal, 0, 0.045, -0.5);                  // muzzle brake
  part(boxOf(0.072, 0.012, 0.1), M.accent, 0, -0.03, -0.07);         // accent strip
  part(boxOf(0.012, 0.03, 0.012), M.accent, 0.038, 0.045, 0.04);     // charging handle

  // Holographic sight: a hood with a glowing pane, the thing ADS lines up.
  part(boxOf(0.056, 0.012, 0.085), M.body, 0, 0.142, -0.1);
  part(boxOf(0.012, 0.062, 0.085), M.body, 0.028, 0.112, -0.1);
  part(boxOf(0.012, 0.062, 0.085), M.body, -0.028, 0.112, -0.1);
  const pane = part(boxOf(0.046, 0.046, 0.004), M.glass, 0, 0.115, -0.132);
  pane.renderOrder = 2;
  const reticle = part(new THREE.RingGeometry(0.004, 0.009, 12), M.accent, 0, 0.115, -0.134);
  reticle.renderOrder = 3;

  // Anchors the character rig reaches its hands to, and the sight line the viewmodel
  // and the third-person aim pose both line up on.
  const anchor = (name, x, y, z) => {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(x, y, z);
    g.add(o);
    return o;
  };
  anchor('muzzle', 0, 0.045, -0.535);
  anchor('sight', 0, 0.115, -0.1);
  anchor('grip', 0.005, -0.055, 0.02);       // where the firing hand wraps the grip
  anchor('foregrip', 0, -0.02, -0.215);      // where the support hand takes the handguard
  anchor('magwell', 0, -0.12, -0.115);       // where the support hand goes on a reload

  g.userData.magazine = magazine;
  g.userData.accent = M.accent;
  return g;
}

// Viewmodel rest poses, in the view camera's own space. ADS puts the sight dead on
// the camera axis: the gun's sight sits at local (0, 0.115, -0.1), so lining it up is
// just a matter of hanging the holder that far below the axis.
const VIEW_SCALE = 0.72;
const SIGHT_Y = 0.115 * VIEW_SCALE;
const HIP = { pos: new THREE.Vector3(0.16, -0.2, -0.58), rot: new THREE.Vector3(0.04, -0.09, 0.05) };
const ADS = { pos: new THREE.Vector3(0, -SIGHT_Y, -0.46), rot: new THREE.Vector3(0, 0, 0) };
const LOW = { pos: new THREE.Vector3(0.24, -0.44, -0.5), rot: new THREE.Vector3(-0.75, -0.45, 0.3) };
// Reverse aim: pulled in to the shoulder and swung round, so the receiver stays in
// frame on the right while the barrel sweeps out of it, pointing behind you. Kept far
// enough out that no part of the gun crosses the view camera's near plane.
const BACK = { pos: new THREE.Vector3(0.32, -0.2, -0.3), rot: new THREE.Vector3(0.06, -2.2, 0.25) };

const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _point = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export class Weapon {
  constructor({ scene, viewScene, world, effects, character }) {
    this.world = world;
    this.effects = effects;
    this.character = character;

    // Third-person gun. The rig mounts it on its own aim pivot and solves both hands
    // onto it, rather than the gun hanging off a hand.
    this.worldGun = buildGun();
    this.worldGun.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    character.attachWeapon(this.worldGun);
    this.worldMuzzle = this.worldGun.getObjectByName('muzzle');
    this.worldFlash = new MuzzleFlash(this.worldMuzzle, 1);

    // First-person viewmodel, rendered by its own camera parked at the origin.
    this.viewHolder = new THREE.Group();
    this.viewHolder.rotation.order = 'YXZ';
    viewScene.add(this.viewHolder);
    this.viewGun = buildGun();
    this.viewGun.scale.setScalar(VIEW_SCALE);
    this.viewHolder.add(this.viewGun);
    this.viewMuzzle = this.viewGun.getObjectByName('muzzle');
    this.viewFlash = new MuzzleFlash(this.viewMuzzle, 0.9, true);

    this.laser = new LaserSight(scene);

    this.cooldown = 0;
    this.fireHold = 0;
    this.adsToggle = false;
    this.boost = 0;              // 0..1, how much of the last shot went into a launch
    this.ammo = MAG_SIZE;
    this.magSize = MAG_SIZE;
    this.reloading = 0;          // seconds left in the reload
    this.reloadSpan = RELOAD_TIME;
    this.charge = 0;             // 0..1 wind-up on the charged shot
    this.holdT = -1;             // -1 while nothing is winding up
    this.chargeFlash = 0;
    this.baseSpread = 0.006;
    this.lowBlend = 0;
    this.reversed = false;       // is the shot line flipped right now
    this.backBlend = 0;          // smoothed, for the viewmodel swing
    this.recoil = 0;             // 0..1, drives every kick in the game
    this.recoilPitch = 0;        // radians added to the camera, recovers to zero
    this.recoilYaw = 0;
    this.bloom = 0;
    this.ads = 0;                // 0 hip, 1 aimed
    this.bob = 0;
    this.sway = new THREE.Vector2();
    this.aimPoint = new THREE.Vector3();
    this.onTarget = false;
    this.hitFlash = 0;
    this.shotsLanded = 0;
  }

  get reloadProgress() { return this.reloading > 0 ? 1 - this.reloading / RELOAD_TIME : 1; }

  // Where the barrel is actually pointed: down the view, or straight back out of it.
  aimDir(camera, out) {
    camera.getWorldDirection(out);
    if (this.reversed) out.negate();
    return out;
  }

  beginReload() {
    if (this.reloading > 0 || this.ammo >= MAG_SIZE) return false;
    this.reloading = RELOAD_TIME;
    this.holdT = -1;
    this.charge = 0;
    return true;
  }

  // --- firing ---------------------------------------------------------------
  fire(eye, camera, thirdPerson, player, charge = 0) {
    this.aimDir(camera, _dir);
    _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    _up.set(0, 1, 0).applyQuaternion(camera.quaternion);

    const s = this.baseSpread;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * s;
    _dir.addScaledVector(_right, Math.cos(a) * r).addScaledVector(_up, Math.sin(a) * r).normalize();

    // Trace from the eye so cover works, but aim along the crosshair ray so the shot
    // lands where the reticle sits even with the third-person camera slung behind.
    // A reversed shot fires back past that camera, so there is no crosshair ray to
    // match and it just leaves the head in the mirrored direction.
    const origin = thirdPerson && this.reversed ? eye : camera.position;
    let hit = traceShot(origin, _dir, RANGE, this.world);
    _aim.copy(hit.point);
    if (thirdPerson && !this.reversed) {
      _tmp.copy(_aim).sub(eye);
      const len = _tmp.length();
      if (len > 0.2) {
        _tmp.divideScalar(len);
        hit = traceShot(eye, _tmp, RANGE, this.world);
      }
    }
    _point.copy(hit.point);
    _normal.copy(hit.normal);
    const kind = hit.kind;
    const object = hit.object;

    // Tracer leaves the barrel you can actually see.
    if (thirdPerson) this.worldMuzzle.getWorldPosition(_muzzle);
    else this.viewMuzzleWorld(camera, _muzzle);
    this.effects.tracer(_muzzle, _point);

    if (kind === 'target') {
      // Hand the target the shot so it knows which way to topple.
      if (object.hit(_dir, _point)) { this.shotsLanded++; this.hitFlash = 1; }
      this.effects.impact(_point, _normal, 0x8affd0, 0.55);
    } else if (kind === 'crate') {
      object.vel.addScaledVector(_dir, 5.5);
      object.vel.y += 1.4;
      this.effects.impact(_point, _normal, 0xffc27a, 0.34);
    } else if (kind === 'world') {
      this.effects.impact(_point, _normal, 0xffd9a0, 0.3);
    }

    this.worldFlash.fire();
    this.viewFlash.fire();
    this.ammo = Math.max(0, this.ammo - 1);
    if (charge > 0) {
      this.dash(player, _dir, charge);
      this.chargeFlash = 1;
      this.boost = 1;
    } else {
      this.boost = this.launch(player, _dir);
    }

    // Recoil: a sharp upward kick plus a little sideways wander. A launching shot
    // kicks noticeably harder.
    const hard = 1 + this.boost + charge * 1.6;
    this.recoil = Math.min(1, this.recoil + 0.85 * hard);
    this.recoilPitch += (0.021 + Math.random() * 0.009) * hard;
    this.recoilYaw += (Math.random() - 0.5) * 0.014;
    this.bloom = Math.min(1, this.bloom + 0.3);
    this.cooldown = COOLDOWN;
    this.fireHold = 1;           // keeps both hands on the gun for a moment after
  }

  // A charged round throws you the other way: level shots read as a sideways dash,
  // downward ones as a launch, and it works in any direction between.
  dash(player, dir, charge) {
    const power = THREE.MathUtils.lerp(DASH_MIN, DASH_MAX, charge);
    player.dash(-dir.x * power, -dir.y * power, -dir.z * power);
  }

  // Firing steeply downward throws the player up along the recoil. Aiming straight
  // down gives the full impulse; it fades out to nothing near the horizon.
  launch(player, dir) {
    const steep = THREE.MathUtils.clamp((-dir.y - BOOST_FLOOR) / (1 - BOOST_FLOOR), 0, 1);
    if (steep <= 0) return 0;

    const impulse = BOOST_IMPULSE * steep;
    // A boost also arrests a fall, so it reads as a save rather than a wasted shot.
    player.vel.y = Math.min(Math.max(player.vel.y, -3) + impulse, BOOST_CEILING);
    player.vel.x -= dir.x * impulse * BOOST_PUSH;
    player.vel.z -= dir.z * impulse * BOOST_PUSH;
    player.grounded = false;
    player.coyote = 0;
    // Coming out of a slide or a dive, stand up into the launch.
    if (player.lowProfile) player.standUp();
    return steep;
  }

  // Where the viewmodel's muzzle appears to be, in world space.
  viewMuzzleWorld(camera, out) {
    this.viewHolder.updateMatrixWorld(true);
    this.viewMuzzle.getWorldPosition(out);
    out.applyQuaternion(camera.quaternion).add(camera.position);
    return out;
  }

  // --- per-frame ------------------------------------------------------------
  update(dt, ctx) {
    const { input, player, camera, eye, thirdPerson } = ctx;

    // Reverse aim: held on F, and the player carries it because the body turns to it.
    // It is dropped during a slide, dive or roll, where the gun is stowed anyway.
    this.reversed = input.isDown('KeyF') && !player.lowProfile;
    player.backAim = this.reversed;
    this.backBlend += ((this.reversed ? 1 : 0) - this.backBlend) * (1 - Math.exp(-13 * dt));

    // Aim: right mouse holds, Q toggles. The toggle is what makes this workable on a
    // trackpad, where you cannot hold a button and steer with the same hand.
    if (input.consumeTap('KeyQ')) this.adsToggle = !this.adsToggle;
    if (player.lowProfile) this.adsToggle = false;
    // There is nothing to line the sight up on behind you, so the sight is out.
    const wantAds = (this.adsToggle || input.mouseDown(2)) && !player.lowProfile && !this.reversed;
    this.ads += ((wantAds ? 1 : 0) - this.ads) * (1 - Math.exp(-14 * dt));

    // Accuracy: standing still and aiming is tight, running and jumping is not.
    const move = THREE.MathUtils.clamp(player.speed / 7, 0, 1.2);
    this.bloom = Math.max(0, this.bloom - dt * 1.6);
    this.baseSpread = (0.006 + move * 0.026 + (player.grounded ? 0 : 0.03) + this.bloom * 0.03)
                    * (1 - this.ads * 0.72);

    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.reloading > 0) {
      this.reloading = Math.max(0, this.reloading - dt);
      if (this.reloading === 0) this.ammo = MAG_SIZE;
    }
    if (input.consumeTap('KeyR')) this.beginReload();

    const blocked = player.rolling || player.diving || this.reloading > 0;
    const ready = this.cooldown === 0 && !blocked;

    // Semi-automatic: one round per press, and a press that lands during the cooldown
    // is dropped rather than queued.
    const pressed = input.consumeClick(0) || input.consumeTap('KeyE');
    if (pressed && ready) {
      if (this.ammo > 0) {
        this.fire(eye, camera, thirdPerson, player);
        this.holdT = 0;                 // the wind-up clock starts from this shot
      } else {
        this.beginReload();             // clicking on empty just reloads
      }
    }

    // Charged shot. The clock only runs while the trigger stays down after a shot
    // that actually left the barrel, so a tap never reaches the meter.
    const held = input.mouseDown(0) || input.isDown('KeyE');
    if (this.holdT >= 0 && held && !blocked && this.ammo > 0) {
      this.holdT += dt;
      this.charge = THREE.MathUtils.clamp((this.holdT - CHARGE_DELAY) / CHARGE_TIME, 0, 1);
    } else if (this.holdT >= 0) {
      if (this.charge >= CHARGE_MIN && this.ammo > 0 && !blocked) {
        this.fire(eye, camera, thirdPerson, player, this.charge);
      }
      this.holdT = -1;
      this.charge = 0;
    }
    if (this.ammo === 0 && this.reloading === 0) this.beginReload();

    this.recoil = Math.max(0, this.recoil - dt * 5.5);
    this.boost = Math.max(0, this.boost - dt * 2.5);
    this.chargeFlash = Math.max(0, this.chargeFlash - dt * 2);
    this.fireHold = Math.max(0, (this.fireHold || 0) - dt * 1.6);
    this.hitFlash = Math.max(0, this.hitFlash - dt * 4);
    // The gun's accent strips glow as the charge winds up.
    const glow = Math.max(this.charge, this.chargeFlash);
    this.worldGun.userData.accent.emissiveIntensity = 0.9 + glow * 5;
    this.viewGun.userData.accent.emissiveIntensity = 0.9 + glow * 5;
    // Recoil recovers by springing the camera offset back to zero.
    const recover = 1 - Math.exp(-9 * dt);
    this.recoilPitch -= this.recoilPitch * recover;
    this.recoilYaw -= this.recoilYaw * recover;

    this.updateViewmodel(dt, ctx, move);
    this.updateLaser(camera, eye, thirdPerson, player);

    this.worldFlash.update(dt);
    this.viewFlash.update(dt);
    this.worldGun.visible = thirdPerson;
  }

  updateViewmodel(dt, ctx, move) {
    const { player, thirdPerson, mouseDelta } = ctx;
    this.viewHolder.visible = !thirdPerson;
    if (thirdPerson) return;

    // Pick the rest pose: hip, aimed, or swung down out of the way for slides.
    const down = player.sliding || player.diving || player.rolling ? 1 : 0;
    this.lowBlend += (down - this.lowBlend) * (1 - Math.exp(-11 * dt));
    const l = this.lowBlend, b = this.backBlend * (1 - l), a = this.ads * (1 - l) * (1 - b);

    // hip -> aimed -> swung behind -> stowed low, each blend layered over the last.
    const stack = (hip, ads, back, low) =>
      THREE.MathUtils.lerp(THREE.MathUtils.lerp(THREE.MathUtils.lerp(hip, ads, a), back, b), low, l);

    const px = stack(HIP.pos.x, ADS.pos.x, BACK.pos.x, LOW.pos.x);
    const py = stack(HIP.pos.y, ADS.pos.y, BACK.pos.y, LOW.pos.y);
    const pz = stack(HIP.pos.z, ADS.pos.z, BACK.pos.z, LOW.pos.z);
    const rx = stack(HIP.rot.x, ADS.rot.x, BACK.rot.x, LOW.rot.x);
    const ry = stack(HIP.rot.y, ADS.rot.y, BACK.rot.y, LOW.rot.y);
    const rz = stack(HIP.rot.z, ADS.rot.z, BACK.rot.z, LOW.rot.z);

    // Sway trails the mouse, bob follows the stride, both muted while aiming.
    const damp = 1 - this.ads * 0.75;
    this.sway.x += (THREE.MathUtils.clamp(-mouseDelta.x * 3.2, -0.09, 0.09) - this.sway.x) * (1 - Math.exp(-9 * dt));
    this.sway.y += (THREE.MathUtils.clamp(-mouseDelta.y * 3.2, -0.07, 0.07) - this.sway.y) * (1 - Math.exp(-9 * dt));

    this.bob += dt * (0.55 + player.speed * 0.17) * Math.PI * 2;
    const bobAmt = move * (player.grounded ? 1 : 0.25) * damp;
    const bx = Math.sin(this.bob) * 0.022 * bobAmt;
    const by = -Math.abs(Math.cos(this.bob)) * 0.02 * bobAmt;
    const air = THREE.MathUtils.clamp(-player.vel.y / 26, -0.05, 0.05) * damp;

    const kick = this.recoil * this.recoil;
    this.viewHolder.position.set(
      px + bx + this.sway.x * damp + kick * 0.008,
      py + by + this.sway.y * damp + air + kick * 0.016,
      pz + kick * 0.09,
    );
    this.viewHolder.rotation.set(
      rx - this.sway.y * 1.5 * damp + kick * 0.3 + Math.sin(this.bob) * 0.012 * bobAmt,
      ry + this.sway.x * 1.6 * damp,
      rz + Math.sin(this.bob * 0.5) * 0.02 * bobAmt + kick * 0.06,
    );
  }

  // The first-person aiming helper: a laser down the shot line with a dot parked on
  // whatever is about to be hit.
  updateLaser(camera, eye, thirdPerson, player) {
    if (thirdPerson) { this.laser.hide(); this.onTarget = false; return; }

    this.aimDir(camera, _dir);
    const hit = traceShot(camera.position, _dir, RANGE, this.world);
    this.aimPoint.copy(hit.point);
    // Still worth knowing a backward shot is lined up on a target, even though the
    // beam itself is behind the camera and has nothing to draw on screen.
    this.onTarget = hit.kind === 'target';
    if (this.reversed) { this.laser.hide(); return; }

    this.viewMuzzleWorld(camera, _origin);
    const strength = 1 - this.lowBlend * 0.85;
    this.laser.update(_origin, this.aimPoint, camera, this.onTarget, strength);
  }
}
