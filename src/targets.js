import * as THREE from 'three';
import { box, rayBox } from './physics.js';

// Pop-up range targets. Each one hinges at its base: a hit knocks the plate flat,
// it lies there for a beat, then springs back upright with a little overshoot.
// Targets are deliberately not part of `world.statics` — you shoot them, you do not
// walk into them.
//
// The hinge aims itself at the shot. `tip` carries both the direction to fall in and
// how far over it has gone; `body` cancels that direction back out so the plate keeps
// facing the way it was planted. Shoot one from the side and it goes over sideways.

const PLATE_R = 0.42;
const PLATE_Y = 0.95;        // plate centre, measured from the hinge
const DOWN_ANGLE = -1.5;
const DOWN_TIME = 1.5;

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _local = new THREE.Vector3();

function faceTexture() {
  const size = 256, c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#f2f5f8';
  g.fillRect(0, 0, size, size);
  const rings = [
    [0.96, '#cf4a45'], [0.80, '#f2f5f8'], [0.64, '#cf4a45'],
    [0.46, '#f2f5f8'], [0.30, '#cf4a45'], [0.13, '#f8e9a0'],
  ];
  for (const [r, color] of rings) {
    g.fillStyle = color;
    g.beginPath();
    g.arc(size / 2, size / 2, (size / 2) * r, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = 'rgba(30,40,50,.35)';
  g.lineWidth = 2;
  for (const [r] of rings) {
    g.beginPath();
    g.arc(size / 2, size / 2, (size / 2) * r, 0, Math.PI * 2);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

let sharedFace = null;

export class Target {
  constructor(scene, x, y, z, yaw) {
    if (!sharedFace) sharedFace = faceTexture();

    this.state = 'up';
    this.angle = 0;
    this.angVel = 0;
    this.timer = 0;
    this.flash = 0;
    this.yaw = yaw;
    this.fallYaw = yaw + Math.PI;   // untouched, it topples away from the firing line
    this.twist = 0;

    this.group = new THREE.Group();
    this.group.position.set(x, y, z);
    scene.add(this.group);

    const steel = new THREE.MeshStandardMaterial({ color: 0x6f7c88, roughness: 0.5, metalness: 0.45 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.4, 0.1, 16), steel);
    base.position.y = 0.05;
    base.castShadow = base.receiveShadow = true;
    this.group.add(base);

    this.tip = new THREE.Group();
    this.tip.rotation.order = 'YXZ';   // fall direction first, then how far over
    this.tip.position.y = 0.1;
    this.group.add(this.tip);

    this.body = new THREE.Group();
    this.tip.add(this.body);

    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, PLATE_Y - 0.18, 0.09), steel);
    post.position.y = (PLATE_Y - 0.18) / 2;
    post.castShadow = true;
    this.body.add(post);

    this.faceMat = new THREE.MeshStandardMaterial({
      map: sharedFace, roughness: 0.62, metalness: 0.05,
      emissive: 0xff7040, emissiveIntensity: 0,
    });
    const rim = new THREE.MeshStandardMaterial({ color: 0x8d9aa8, roughness: 0.45, metalness: 0.4 });
    const plate = new THREE.Mesh(
      new THREE.CylinderGeometry(PLATE_R, PLATE_R, 0.1, 28),
      [rim, this.faceMat, rim],
    );
    plate.rotation.x = -Math.PI / 2;   // the cap that was +Y now faces -Z, the front
    plate.position.y = PLATE_Y;
    plate.castShadow = plate.receiveShadow = true;
    this.body.add(plate);

    this.lampMat = new THREE.MeshStandardMaterial({ color: 0x2c3b33, emissive: 0x39d98b, emissiveIntensity: 1.6 });
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.05), this.lampMat);
    lamp.position.set(0, 0.16, -0.06);
    this.body.add(lamp);

    this.plateBox = box(0, PLATE_Y, 0, PLATE_R, PLATE_R, 0.08);
    this.inv = new THREE.Matrix4();
    this.place();
  }

  get standing() { return this.state === 'up' || this.state === 'rising'; }

  // Push the current angle, fall direction and twist into the scene graph, and cache
  // the plate's inverse so the next ray test is in plate space.
  place() {
    this.tip.rotation.set(this.angle, this.fallYaw, 0);
    this.body.rotation.y = this.yaw - this.fallYaw + this.twist;
    this.group.updateMatrixWorld(true);   // whole chain, so `inv` is never a frame behind
    this.inv.copy(this.body.matrixWorld).invert();
  }

  // `dir` is the way the round was travelling, `point` where it landed. The target
  // goes over along the shot, faster for a hit high on the plate, and twists away
  // from a hit out towards one edge.
  hit(dir, point) {
    if (!this.standing) return false;

    if (dir) this.fallYaw = Math.atan2(-dir.x, -dir.z);
    let high = 0, off = 0;
    if (point) {
      _local.copy(point).applyMatrix4(this.inv);
      high = THREE.MathUtils.clamp((_local.y - PLATE_Y) / PLATE_R, -1, 1);
      off = THREE.MathUtils.clamp(_local.x / PLATE_R, -1, 1);
    }

    this.state = 'falling';
    this.angVel = -(6.8 + high * 2.6) - Math.random() * 1.6;
    this.twist = -off * 0.5;
    this.flash = 1;
    return true;
  }

  reset() {
    this.state = 'up';
    this.angle = 0;
    this.angVel = 0;
    this.timer = 0;
    this.twist = 0;
    this.fallYaw = this.yaw + Math.PI;
  }

  update(dt) {
    switch (this.state) {
      case 'falling':
        this.angVel -= 11 * dt;
        this.angle += this.angVel * dt;
        if (this.angle <= DOWN_ANGLE) {
          this.angle = DOWN_ANGLE;
          // One small bounce off the stop, then it settles.
          if (this.angVel < -3.5) this.angVel *= -0.22;
          else { this.angVel = 0; this.state = 'down'; this.timer = DOWN_TIME; }
        }
        break;
      case 'down':
        this.timer -= dt;
        if (this.timer <= 0) { this.state = 'rising'; this.angVel = 0; }
        break;
      case 'rising':
        this.angVel += -this.angle * 60 * dt;
        this.angVel *= Math.exp(-4.5 * dt);
        this.angle += this.angVel * dt;
        if (this.angle > 0.3) { this.angle = 0.3; this.angVel = Math.min(this.angVel, 0); }
        if (Math.abs(this.angle) < 0.02 && Math.abs(this.angVel) < 0.4) {
          this.angle = 0; this.angVel = 0; this.state = 'up';
        }
        break;
      default:
        break;
    }

    if (this.state !== 'falling') this.twist -= this.twist * (1 - Math.exp(-5 * dt));
    this.place();

    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 3.2);
      this.faceMat.emissiveIntensity = this.flash * 1.4;
    }
    const lit = this.standing;
    this.lampMat.emissive.setHex(lit ? 0x39d98b : 0xd94a4a);
    this.lampMat.emissiveIntensity = lit ? 1.6 : 0.5;
  }

  // Ray test in the plate's own space, so the hinge tilt is handled for free.
  raycast(origin, dir, maxDist, face) {
    if (!this.standing) return null;
    _o.copy(origin).applyMatrix4(this.inv);
    _d.copy(dir).transformDirection(this.inv);
    return rayBox(_o, _d, this.plateBox, maxDist, face);
  }

  faceNormal(out) {
    out.set(0, 0, -1).transformDirection(this.body.matrixWorld);
  }
}

export function createTargets(scene, spawn) {
  // x, z, ground height, listed roughly near-to-far from the spawn.
  const spots = [
    [-9, 6, 0], [9, 3, 0], [-12, -12, 0], [5, -18, 0], [0, -27, 0],
    [20, 3.5, 3.4], [-20, 4, 2.75], [17, -0.5, 4.2], [-25, -8, 4.5],
  ];
  return spots.map(([x, z, y]) => {
    const yaw = Math.atan2(x - spawn.x, z - spawn.z);   // plate faces back toward the spawn
    return new Target(scene, x, y, z, yaw);
  });
}
