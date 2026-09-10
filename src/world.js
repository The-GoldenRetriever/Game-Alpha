import * as THREE from 'three';
import { box, makeCrate } from './physics.js';

function gridTexture() {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#57646f';
  g.fillRect(0, 0, size, size);
  g.strokeStyle = '#6d7d8a';
  g.lineWidth = 6;
  g.strokeRect(0, 0, size, size);
  g.strokeStyle = '#616f7b';
  g.lineWidth = 2;
  for (let i = 1; i < 4; i++) {
    const p = (size / 4) * i;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(size, p); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(17, 17);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildWorld(scene) {
  const statics = [];
  const crates = [];
  const world = { statics, crates, spawn: new THREE.Vector3(0, 1.5, 24) };

  scene.background = new THREE.Color(0x1b2836);
  scene.fog = new THREE.Fog(0x1b2836, 70, 165);

  scene.add(new THREE.HemisphereLight(0xa8ccff, 0x4a5158, 1.6));
  const sun = new THREE.DirectionalLight(0xffeeda, 2.6);
  sun.position.set(30, 46, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -50;
  sun.shadow.camera.right = 50;
  sun.shadow.camera.top = 50;
  sun.shadow.camera.bottom = -50;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 160;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);

  const mat = {
    platform: new THREE.MeshStandardMaterial({ color: 0x8496a6, roughness: 0.85, metalness: 0.05 }),
    accent: new THREE.MeshStandardMaterial({ color: 0x59b3ac, roughness: 0.75, metalness: 0.08 }),
    wall: new THREE.MeshStandardMaterial({ color: 0x4a5766, roughness: 0.95 }),
    crate: new THREE.MeshStandardMaterial({ color: 0xd08a45, roughness: 0.7, metalness: 0.05 }),
    lane: new THREE.MeshStandardMaterial({ color: 0x5b6a77, roughness: 0.5 }),
  };

  const addSolid = (x, y, z, sx, sy, sz, material = mat.platform) => {
    statics.push(box(x, y, z, sx / 2, sy / 2, sz / 2));
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  };
  // Place a block by the height of its top face (grows down to `bottom`).
  const addBlock = (x, z, sx, sz, top, material, bottom = 0) =>
    addSolid(x, (top + bottom) / 2, z, sx, top - bottom, sz, material);
  // A thin floating slab, positioned by its top face.
  const addSlab = (x, z, sx, sz, top, material) =>
    addSolid(x, top - 0.3, z, sx, 0.6, sz, material);

  // --- ground -------------------------------------------------------------
  const HALF = 34;
  statics.push(box(0, -1, 0, HALF, 1, HALF));
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(HALF * 2, HALF * 2),
    new THREE.MeshStandardMaterial({ map: gridTexture(), roughness: 0.9 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // --- perimeter walls ----------------------------------------------------
  addSolid(0, 2.5, -HALF, HALF * 2, 5, 1, mat.wall);
  addSolid(0, 2.5, HALF, HALF * 2, 5, 1, mat.wall);
  addSolid(-HALF, 2.5, 0, 1, 5, HALF * 2, mat.wall);
  addSolid(HALF, 2.5, 0, 1, 5, HALF * 2, mat.wall);

  // --- slide lane: a long clear strip for building up speed ---------------
  const lane = new THREE.Mesh(new THREE.PlaneGeometry(8, 50), mat.lane);
  lane.rotation.x = -Math.PI / 2;
  lane.position.set(0, 0.02, 2);
  lane.receiveShadow = true;
  scene.add(lane);

  // Two low pads with a wide gap — clearable with a slide jump, not a walking one.
  addBlock(0, -8, 7, 4, 0.9, mat.accent);
  addBlock(0, -16.8, 7, 4, 0.9, mat.accent);

  // --- staircase up to the west terrace -----------------------------------
  for (let i = 0; i < 5; i++) addBlock(-20, 16 - i * 2, 8, 2, 0.55 + i * 0.55, mat.platform);
  addBlock(-20, 0.5, 12, 13, 2.75, mat.platform);
  addBlock(-25, -8, 6, 5, 4.5, mat.accent);

  // --- jump course: rising blocks with widening gaps ----------------------
  addBlock(10, 16, 4.5, 4.5, 1.0, mat.platform);
  addBlock(14, 12, 4, 4, 1.8, mat.platform);
  addBlock(17.5, 8, 4, 4, 2.6, mat.accent);
  addBlock(20, 3.5, 3.5, 3.5, 3.4, mat.platform);
  addBlock(17, -0.5, 4, 4, 4.2, mat.accent);

  // --- floating platforms curving back over the lane ----------------------
  addSlab(12, -5, 4.5, 4.5, 4.8, mat.platform);
  addSlab(7, -9.5, 4.5, 4.5, 5.4, mat.accent);
  addSlab(1, -13.5, 5, 4.5, 5.4, mat.platform);
  addSlab(-5, -18, 5, 5, 6.0, mat.accent);
  addSlab(-2, -24, 7, 5, 6.6, mat.platform);

  // --- pillars (also good for testing camera collision) -------------------
  addSolid(-9, 1.6, 6, 1.6, 3.2, 1.6, mat.wall);
  addSolid(9, 1.6, 22, 1.6, 3.2, 1.6, mat.wall);

  // --- movable crates -----------------------------------------------------
  const crateSpawns = [
    [-4, 14, 0, 1.2], [-2.2, 12.2, 0, 1.2], [3, 15.5, 0, 1.2],
    [6, 8, 0, 1.6], [-7, 4, 0, 1.6], [9, 19, 0, 1.2],
    [-19, 2, 2.75, 1.2], [-21, -1, 2.75, 1.2],
  ];
  for (const [x, z, base, size] of crateSpawns) {
    const crate = makeCrate(x, base + size / 2 + 0.02, z, size);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), mat.crate);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    crate.mesh = mesh;
    crate.prev = crate.pos.clone();
    crate.spawn = crate.pos.clone();
    crates.push(crate);
  }

  world.resetCrates = () => {
    for (const c of crates) {
      c.pos.copy(c.spawn);
      c.prev.copy(c.spawn);
      c.vel.set(0, 0, 0);
    }
  };

  return world;
}
