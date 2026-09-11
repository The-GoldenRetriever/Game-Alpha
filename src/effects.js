import * as THREE from 'three';

// Small pooled effects: shot tracers, impact flashes, muzzle flashes and the
// first-person laser sight. Everything is additive and depth-write free so nothing
// has to be sorted.

function radialTexture(inner = '#ffffff', outer = 'rgba(255,255,255,0)') {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function starTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.translate(64, 64);
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, 64);
  grad.addColorStop(0, '#fffdf0');
  grad.addColorStop(0.25, 'rgba(255,214,120,0.85)');
  grad.addColorStop(1, 'rgba(255,150,40,0)');
  g.fillStyle = grad;
  g.beginPath(); g.arc(0, 0, 46, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(255,246,214,0.95)';
  for (let i = 0; i < 4; i++) {
    g.rotate(Math.PI / 4);
    g.beginPath();
    g.moveTo(-62, 0); g.lineTo(0, -9); g.lineTo(62, 0); g.lineTo(0, 9);
    g.closePath(); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const beamGeometry = () => new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).rotateX(Math.PI / 2);

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.glow = radialTexture();
    this.time = 0;

    const beam = beamGeometry();
    this.tracers = [];
    for (let i = 0; i < 14; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffe6a8, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(beam, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.tracers.push({ mesh, mat, life: 0, ttl: 1 });
    }

    const quad = new THREE.PlaneGeometry(1, 1);
    this.impacts = [];
    for (let i = 0; i < 16; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.glow, color: 0xffd9a0, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(quad, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.impacts.push({ mesh, mat, life: 0 });
    }
  }

  tracer(from, to, width = 0.035, ttl = 0.09, color = 0xffe6a8) {
    const t = this.tracers.reduce((a, b) => (a.life <= b.life ? a : b));
    const len = from.distanceTo(to);
    if (len < 0.05) return;
    t.mesh.visible = true;
    t.mesh.position.copy(from).lerp(to, 0.5);
    t.mesh.lookAt(to);
    t.mesh.scale.set(width, width, len);
    t.mat.color.setHex(color);
    t.mat.opacity = 0.95;
    t.width = width;
    t.life = ttl;
    t.ttl = ttl;
  }

  impact(point, normal, color = 0xffd9a0, size = 0.42) {
    const i = this.impacts.reduce((a, b) => (a.life <= b.life ? a : b));
    i.mesh.visible = true;
    i.mesh.position.copy(point).addScaledVector(normal, 0.02);
    i.mesh.lookAt(_v.copy(point).addScaledVector(normal, 1));
    i.mesh.rotation.z = Math.random() * Math.PI;
    i.mat.color.setHex(color);
    i.mat.opacity = 1;
    i.life = 1;
    i.size = size;
    i.mesh.scale.setScalar(size * 0.35);
  }

  update(dt) {
    this.time += dt;
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      const k = Math.max(t.life, 0) / t.ttl;
      t.mat.opacity = k * 0.95;
      t.mesh.scale.x = t.mesh.scale.y = t.width * (0.35 + k * 0.65);
      if (t.life <= 0) t.mesh.visible = false;
    }
    for (const i of this.impacts) {
      if (i.life <= 0) continue;
      i.life -= dt * 4.5;
      const k = Math.max(i.life, 0);
      i.mat.opacity = k * k;
      i.mesh.scale.setScalar(i.size * (0.35 + (1 - k) * 1.1));
      if (i.life <= 0) i.mesh.visible = false;
    }
  }
}

const _v = new THREE.Vector3();

// A flash anchored to a gun muzzle; lives in whichever scene the gun does.
export class MuzzleFlash {
  constructor(anchor, scale = 1, overlay = false) {
    this.mat = new THREE.MeshBasicMaterial({
      map: starTexture(), color: 0xffe0a0, transparent: true, opacity: 0,
      depthWrite: false, depthTest: !overlay, blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.mesh.scale.setScalar(0.3 * scale);
    this.mesh.visible = false;
    this.mesh.renderOrder = 5;
    anchor.add(this.mesh);

    this.light = new THREE.PointLight(0xffb865, 0, 7, 2);
    anchor.add(this.light);

    this.scale = scale;
    this.life = 0;
  }

  fire() {
    this.life = 1;
    this.mesh.visible = true;
    this.mesh.rotation.z = Math.random() * Math.PI;
    this.mesh.scale.setScalar((0.26 + Math.random() * 0.1) * this.scale);
  }

  update(dt) {
    if (this.life <= 0) return;
    this.life -= dt * 16;
    const k = Math.max(this.life, 0);
    this.mat.opacity = k;
    this.light.intensity = k * 9;
    if (this.life <= 0) { this.mesh.visible = false; this.light.intensity = 0; }
  }
}

// The first-person aiming helper: a beam down the barrel line plus a dot sitting on
// whatever the shot would hit. The dot is scaled with distance so it keeps a constant
// size on screen, and it changes colour when a target is under it.
export class LaserSight {
  constructor(scene) {
    this.beamMat = new THREE.MeshBasicMaterial({
      color: 0xff5a56, transparent: true, opacity: 0.32, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.beam = new THREE.Mesh(beamGeometry(), this.beamMat);
    this.beam.frustumCulled = false;
    this.beam.visible = false;
    scene.add(this.beam);

    this.dotMat = new THREE.MeshBasicMaterial({
      map: radialTexture(), color: 0xff5a56, transparent: true, opacity: 0.9,
      depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    });
    this.dot = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.dotMat);
    this.dot.renderOrder = 4;
    this.dot.visible = false;
    scene.add(this.dot);

    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xff5a56, transparent: true, opacity: 0.5, depthWrite: false,
      depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.44, 0.5, 24), this.ringMat);
    this.ring.renderOrder = 4;
    this.ring.visible = false;
    scene.add(this.ring);
  }

  hide() {
    this.beam.visible = this.dot.visible = this.ring.visible = false;
  }

  // `onTarget` swings the whole helper to the hit colour so you can tell at a glance.
  update(origin, point, camera, onTarget, strength = 1) {
    const len = origin.distanceTo(point);
    this.beam.visible = len > 0.3;
    this.beam.position.copy(origin).lerp(point, 0.5);
    this.beam.lookAt(point);
    this.beam.scale.set(0.006, 0.006, len);

    const dist = camera.position.distanceTo(point);
    const size = THREE.MathUtils.clamp(dist * 0.035, 0.05, 1.6);
    this.dot.visible = this.ring.visible = true;
    this.dot.position.copy(point);
    this.dot.quaternion.copy(camera.quaternion);
    this.dot.scale.setScalar(size * (onTarget ? 1.35 : 1));
    this.ring.position.copy(point);
    this.ring.quaternion.copy(camera.quaternion);
    this.ring.scale.setScalar(size * (onTarget ? 2.5 : 1.7));

    const hex = onTarget ? 0x6cf0b8 : 0xff5a56;
    this.dotMat.color.setHex(hex);
    this.ringMat.color.setHex(hex);
    this.beamMat.color.setHex(hex);
    this.beamMat.opacity = 0.3 * strength;
    this.dotMat.opacity = (onTarget ? 1 : 0.85) * strength;
    this.ringMat.opacity = (onTarget ? 0.75 : 0.42) * strength;
  }
}
