import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as pdfjs from 'pdfjs';

pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.mjs';

const $ = (id) => document.getElementById(id);
const view = $('view');

/* ---------- renderer / scene ---------- */
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 0.82;
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;

const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 80);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.03;
controls.minDistance = 1.5;
controls.maxDistance = 30;

const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 0.5);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.radius = 4;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.01;
scene.add(sun, sun.target);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const blob = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(128, 128, 20, 128, 128, 128);
  g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.55, 'rgba(0,0,0,0.22)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 256, 256);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, fog: false }));
  m.rotation.x = -Math.PI / 2; m.renderOrder = -1; scene.add(m); return m;
})();

const BGS = { light: 0xb9b7b2, dark: 0x151517, warm: 0xa89678 };
function setBackground(k) {
  const c = new THREE.Color(BGS[k]);
  scene.background = c;
  scene.fog = new THREE.Fog(c, 18, 45);
  ground.material.color.copy(c);
  hemi.intensity = k === 'dark' ? 0.2 : 0.3;
  sun.intensity = k === 'dark' ? 2.2 : 1.7;
}

/* ---------- paper ---------- */
const noise = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d'); const d = x.createImageData(256, 256);
  for (let i = 0; i < d.data.length; i += 4) { const v = 128 + (Math.random() - 0.5) * 90; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
  x.putImageData(d, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(10, 14); return t;
})();

const FINISH = {
  matte: { roughness: 0.92, clearcoat: 0, clearcoatRoughness: 0.5, bump: 0.5 },
  silk:  { roughness: 0.6,  clearcoat: 0.15, clearcoatRoughness: 0.45, bump: 0.2 },
  gloss: { roughness: 0.35, clearcoat: 0.7, clearcoatRoughness: 0.12, bump: 0.05 },
};
const GSM = { 80: { gap: 0.0022, bend: 1.5 }, 130: { gap: 0.0035, bend: 1.1 }, 170: { gap: 0.0046, bend: 0.8 }, 250: { gap: 0.0068, bend: 0.5 } };

/* ---------- book ---------- */
const SEG = 56, ROWS = 12;
const LAM = 0.085; // gutter crease width as a fraction of page width
let book = null; // { group, leaves, N, W, H, gap, ... }
let pos = 0, target = 0, tween = null;
const state = { finish: 'matte', gsm: 130, spreads: false };
let source = { kind: 'sample' };

function patchGutter(m) {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aS;\nvarying float vS;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvS = aS;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vS;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 1.0 - 0.45 * exp(-vS * 15.0) - 0.08 * exp(-vS * 3.0);');
  };
}

function makeMaterial(tex, side, mirror) {
  const f = FINISH[state.finish];
  const m = new THREE.MeshPhysicalMaterial({
    map: tex, side, roughness: f.roughness, clearcoat: f.clearcoat, clearcoatRoughness: f.clearcoatRoughness,
    bumpMap: noise, bumpScale: f.bump, envMapIntensity: 0.6,
    sheen: 0.1, sheenRoughness: 0.9, sheenColor: new THREE.Color(0xffffff),
  });
  patchGutter(m);
  return m;
}

function disposeBook() {
  if (!book) return;
  scene.remove(book.group);
  book.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  book.textures.forEach((t) => t.dispose());
  book = null;
}

function buildBook(canvases) {
  disposeBook();
  const pagesArr = canvases.slice();
  if (pagesArr.length % 2) {
    const b = document.createElement('canvas'); b.width = pagesArr[0].width; b.height = pagesArr[0].height;
    const x = b.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, b.width, b.height); pagesArr.push(b);
  }
  const N = pagesArr.length / 2;
  const H = 3, W = H * (pagesArr[0].width / pagesArr[0].height);
  const { gap } = GSM[state.gsm];
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const textures = pagesArr.map((c) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso; return t;
  });

  const group = new THREE.Group();
  const leaves = [];
  const idx = [];
  const S1 = SEG + 1;
  for (let j = 0; j < ROWS; j++) for (let k = 0; k < SEG; k++) {
    const a = j * S1 + k, b = a + 1, c = a + S1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }

  for (let i = 0; i < N; i++) {
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(S1 * (ROWS + 1) * 3);
    const uv = new Float32Array(S1 * (ROWS + 1) * 2);
    for (let j = 0; j <= ROWS; j++) for (let k = 0; k <= SEG; k++) uv.set([k / SEG, 1 - j / ROWS], (j * S1 + k) * 2);
    const aS = new Float32Array(S1 * (ROWS + 1));
    for (let j = 0; j <= ROWS; j++) for (let k = 0; k <= SEG; k++) aS[j * S1 + k] = k / SEG;
    g.setAttribute('aS', new THREE.BufferAttribute(aS, 1));
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.addGroup(0, idx.length, 0);
    g.addGroup(0, idx.length, 1);

    const front = textures[i * 2];
    const back = textures[i * 2 + 1].clone();
    back.needsUpdate = true;
    back.repeat.x = -1; back.offset.x = 1; back.wrapS = THREE.RepeatWrapping;
    textures.push(back);
    const mesh = new THREE.Mesh(g, [makeMaterial(front, THREE.FrontSide), makeMaterial(back, THREE.BackSide)]);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
    leaves.push({ mesh, geo: g, stiff: (i === 0 || i === N - 1) ? 0.35 : 1 });
  }

  // page-edge blocks so the stacks read as thick, not paper-thin
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0xf1efe9, roughness: 0.95, side: THREE.DoubleSide });
  edgeMat.onBeforeCompile = (sh) => {
    sh.uniforms.uGap = { value: gap };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vEY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEY = transformed.y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGap;\nvarying float vEY;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 0.9 + 0.1 * smoothstep(-0.3, 0.6, sin(vEY / uGap * 6.2831853));');
  };
  const mkEdge = () => { const m = new THREE.Mesh(new THREE.BufferGeometry(), edgeMat); m.castShadow = true; m.receiveShadow = true; group.add(m); return m; };
  const edgeR = mkEdge(), edgeL = mkEdge();
  const spine = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), edgeMat); spine.castShadow = true; group.add(spine);

  scene.add(group);
  book = { group, leaves, N, W, H, gap, textures, edgeR, edgeL, spine, dip: Math.min(0.07, W * 0.03) };
  ground.position.y = -book.dip - 0.002;
  blob.position.y = ground.position.y + 0.002;

  // lights + camera framing
  const R = Math.max(W * 2, H);
  sun.position.set(R * 0.55, R * 1.9, R * 0.8);
  sun.target.position.set(0, 0, 0);
  const sc = sun.shadow.camera;
  sc.left = -W * 1.7; sc.right = W * 1.7; sc.top = H * 1.2; sc.bottom = -H * 1.2; sc.near = 0.5; sc.far = R * 6;
  sc.updateProjectionMatrix();

  $('slider').max = N;
  pos = target = 0; tween = null;
  $('slider').value = 0;
  applyCamera('angled', true);
  $('cam').value = 'angled';
  update();
}

const smooth = (x) => x * x * (3 - 2 * x);

function update() {
  if (!book) return;
  const { leaves, N, W, H, gap, dip, edgeR, edgeL } = book;
  const { bend } = GSM[state.gsm];
  const ds = W / SEG;

  for (let i = 0; i < N; i++) {
    const t = Math.min(1, Math.max(0, pos - i));
    const L = leaves[i];
    L.mesh.visible = true;
    const th = t * Math.PI;
    const yR = (N - i) * gap, yL = i * gap;
    const y0 = yR + (yL - yR) * smooth(t);
    const c = bend * L.stiff * Math.sin(2 * Math.PI * t) * 0.55; // extra angle across the page
    const tw = 0.22 * L.stiff * Math.sin(2 * Math.PI * t);        // diagonal lift: grabbed corner leads
    const dipW = 1 - Math.sin(Math.PI * t);
    const arr = L.geo.attributes.position.array;
    for (let j = 0; j <= ROWS; j++) {
      const zn = j / ROWS, zz = 2 * zn - 1;
      const thr = th + tw * zz;
      const cr = c * (1 + 0.7 * zz);
      let x = 0, y = y0 - dip * dipW;
      for (let k = 0; k <= SEG; k++) {
        const o = (j * (SEG + 1) + k) * 3;
        arr[o] = x; arr[o + 1] = y; arr[o + 2] = -H / 2 + zn * H;
        const a = thr + cr * ((k + 0.5) / SEG);
        x += Math.cos(a) * ds;
        y += Math.sin(a) * ds;
        // gutter crease: decaying offset from the spine, added as its per-segment difference
        y += dip * dipW * (Math.exp(-(k * ds) / (W * LAM)) - Math.exp(-((k + 1) * ds) / (W * LAM)));
      }
    }
    L.geo.attributes.position.needsUpdate = true;
    L.geo.computeVertexNormals();
    L.geo.computeBoundingSphere();
  }

  // edge blocks follow the remaining stacks
  const f = Math.min(N, Math.floor(pos + 1e-6));        // leaves fully turned
  const inTransit = pos - f > 1e-4 ? 1 : 0;
  const rightLeaves = N - f - inTransit;                 // flat on the right
  const leftLeaves = f;
  const eps = gap * 0.45, inset = 0.006;
  const setBlock = (m, n, top, side) => {
    m.visible = n > 0;
    const key = n + ':' + gap;
    if (n <= 0 || m.userData.n === key) return;
    m.userData.n = key;
    m.geometry.dispose();
    const pts = [new THREE.Vector2(0, -book.dip), new THREE.Vector2(side * (W - inset), -book.dip)];
    for (let j = 0; j <= 24; j++) {
      const x = (W - inset) * (1 - j / 24);
      const yy = Math.max(-book.dip + 0.0005, top - eps - book.dip * Math.exp(-x / (W * LAM)));
      pts.push(new THREE.Vector2(side * x, yy));
    }
    const d = H - inset * 2;
    const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: d, bevelEnabled: false });
    g.translate(0, 0, -d / 2);
    m.geometry = g;
  };
  setBlock(edgeR, rightLeaves, rightLeaves * gap, 1);
  setBlock(edgeL, leftLeaves, (leftLeaves - 1) * gap, -1);
  // spine block closes the gutter so both stacks read as one bound object
  const sTop = Math.max(rightLeaves * gap, (leftLeaves - 1) * gap) - eps - book.dip;
  const sh = Math.max(0.001, sTop + book.dip);
  book.spine.scale.set(0.05, sh, H - inset * 2);
  book.spine.position.set(0, -book.dip + sh / 2, 0);

  const open = Math.min(pos, 1);
  const closeEnd = Math.max(0, pos - (N - 1));
  book.group.position.x = -(W / 2) * (1 - open) + (W / 2) * closeEnd;
  sun.target.position.x = book.group.position.x;
  const R = 1 - closeEnd, Lw = open, tot = Math.max(0.001, R + Lw);
  blob.scale.set(W * tot * 1.5 + 0.8, H * 1.35 + 0.8, 1);
  blob.position.x = book.group.position.x + (W / 2) * (R - Lw) / tot;

  updateLabel();
}

function updateLabel() {
  if (!book) return;
  const s = Math.round(pos), N = book.N;
  const sl = $('slider');
  if (document.activeElement !== sl) sl.value = pos;
  $('label').textContent = s === 0 ? 'Cover' : s === N ? 'Back cover' : `Pages ${2 * s}–${2 * s + 1} of ${2 * N}`;
}

/* ---------- navigation ---------- */
function goTo(p, quick) {
  if (!book) return;
  p = Math.max(0, Math.min(book.N, Math.round(p)));
  if (p === target && !tween) return;
  target = p;
  const d = Math.abs(p - pos);
  tween = { from: pos, to: p, t0: performance.now(), dur: quick ? 0 : (0.7 + 0.22 * Math.sqrt(d)) * 1000 };
}
const step = (dir) => goTo(Math.round(tween ? target : pos) + dir);
const ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * x);

$('next').onclick = () => step(1);
$('prev').onclick = () => step(-1);
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT') return;
  if (e.key === 'ArrowRight' || e.key === ' ') { step(1); e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { step(-1); e.preventDefault(); }
  else if (e.key === 'Home') goTo(0);
  else if (e.key === 'End' && book) goTo(book.N);
});
const slider = $('slider');
slider.addEventListener('input', () => { tween = null; pos = target = parseFloat(slider.value); update(); });
slider.addEventListener('change', () => { goTo(pos); slider.blur(); });

// grab a page and drag to turn it; a plain click turns toward that side
const dom = renderer.domElement;
const rc = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function groundHit(e) {
  const r = dom.getBoundingClientRect();
  camera.updateMatrixWorld();
  rc.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const p = new THREE.Vector3();
  return rc.ray.intersectPlane(plane, p) ? p : null;
}
function onBook(p) {
  if (!book || !p) return false;
  const sx = book.group.position.x;
  return Math.abs(p.z) <= book.H / 2 && p.x >= sx - book.W && p.x <= sx + book.W;
}
let drag = null;
dom.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !book) return;
  const p = groundHit(e);
  drag = { x: e.clientX, y: e.clientY, t: performance.now(), onBook: onBook(p), hit: p, mode: null, start: Math.round(tween ? target : pos) };
  if (drag.onBook) { controls.enabled = false; dom.setPointerCapture(e.pointerId); }
});
dom.addEventListener('pointermove', (e) => {
  if (!book) return;
  if (!drag) { dom.style.cursor = onBook(groundHit(e)) ? 'grab' : 'default'; return; }
  if (!drag.onBook) return;
  const moved = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
  if (!drag.mode && moved > 5) {
    const forward = drag.hit.x > book.group.position.x;
    if ((forward && drag.start >= book.N) || (!forward && drag.start <= 0)) { drag.mode = 'none'; }
    else { drag.mode = forward ? 'fwd' : 'back'; tween = null; pos = target = drag.start; dom.style.cursor = 'grabbing'; }
  }
  if (drag.mode === 'fwd' || drag.mode === 'back') {
    const p = groundHit(e); if (!p) return;
    const dx = (p.x - drag.hit.x) / (book.W * 0.9);
    const prog = Math.min(1, Math.max(0, drag.mode === 'fwd' ? -dx : dx));
    drag.prog = prog;
    pos = drag.mode === 'fwd' ? drag.start + prog : drag.start - prog;
    update();
  }
});
function endDrag(e) {
  if (!drag) return;
  controls.enabled = true;
  const d = drag; drag = null;
  dom.style.cursor = 'default';
  if (!book) return;
  const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
  if (d.mode === 'fwd' || d.mode === 'back') {
    const commit = d.prog > 0.28;
    const dest = commit ? d.start + (d.mode === 'fwd' ? 1 : -1) : d.start;
    target = NaN;
    const dist = Math.abs(dest - pos);
    target = dest;
    tween = { from: pos, to: dest, t0: performance.now(), dur: (0.35 + 0.5 * dist) * 1000 };
  } else if (d.onBook && moved < 5 && performance.now() - d.t < 450) {
    step(d.hit.x > book.group.position.x ? 1 : -1);
  }
}
dom.addEventListener('pointerup', endDrag);
dom.addEventListener('pointercancel', endDrag);

/* ---------- camera presets ---------- */
let camTween = null;
function applyCamera(k, instant) {
  if (!book) return;
  const D = Math.max(book.W * 2, book.H) * 1.45;
  const P = { angled: [0, D * 0.82, D * 0.78], top: [0, D * 1.15, 0.001], close: [0, D * 0.42, D * 0.52] }[k];
  const to = new THREE.Vector3(...P);
  if (instant) { camera.position.copy(to); controls.target.set(0, 0, 0); controls.update(); camTween = null; return; }
  camTween = { from: camera.position.clone(), to, t0: performance.now() };
}

/* ---------- loading ---------- */
async function pdfToCanvases(buf, spreads, onProgress) {
  const pdf = await pdfjs.getDocument({ data: buf.slice(0), standardFontDataUrl: './vendor/pdfjs/standard_fonts/', cMapUrl: './vendor/pdfjs/cmaps/', cMapPacked: true }).promise;
  const first = await pdf.getPage(1);
  const v0 = first.getViewport({ scale: 1 });
  const wPage = spreads ? v0.width / 2 : v0.width;
  const aspect = v0.height / wPage;
  const total = pdf.numPages * (spreads ? 2 : 1);
  const texW = Math.floor(Math.min(1600, Math.sqrt(90e6 / (total * aspect))));
  const out = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const scale = (spreads ? texW * 2 : texW) / page.getViewport({ scale: 1 }).width;
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
    if (spreads) out.push(...splitCanvas(c)); else out.push(c);
    onProgress(p, pdf.numPages);
  }
  return out;
}
function splitCanvas(c) {
  const hw = Math.floor(c.width / 2);
  return [0, 1].map((i) => {
    const o = document.createElement('canvas'); o.width = hw; o.height = c.height;
    o.getContext('2d').drawImage(c, i * hw, 0, hw, c.height, 0, 0, hw, c.height);
    return o;
  });
}
async function imagesToCanvases(files, spreads) {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const out = [];
  for (const f of sorted) {
    const bmp = await createImageBitmap(f);
    const s = Math.min(1, 1600 / (spreads ? bmp.width / 2 : bmp.width));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height);
    if (spreads) out.push(...splitCanvas(c)); else out.push(c);
  }
  return out;
}

async function load() {
  $('busy').style.display = 'flex';
  const busy = $('busy');
  try {
    let canvases;
    if (source.kind === 'sample') canvases = makeSample();
    else if (source.kind === 'pdf') canvases = await pdfToCanvases(source.buf, state.spreads, (p, n) => { busy.textContent = `Rendering page ${p} of ${n}…`; });
    else canvases = await imagesToCanvases(source.files, state.spreads);
    buildBook(canvases);
    const n = canvases.length;
    $('fileinfo').textContent = (source.name || 'Sample booklet') + ` · ${n} pages`;
  } catch (err) {
    console.error(err);
    busy.textContent = 'Could not read that file: ' + err.message;
    await new Promise((r) => setTimeout(r, 2500));
  }
  busy.style.display = 'none';
}

async function openFiles(files) {
  files = [...files];
  if (!files.length) return;
  const pdf = files.find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (pdf) source = { kind: 'pdf', buf: await pdf.arrayBuffer(), name: pdf.name };
  else {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    source = { kind: 'images', files: imgs, name: imgs.length === 1 ? imgs[0].name : `${imgs.length} images` };
  }
  load();
}

$('open').onclick = () => $('file').click();
$('file').onchange = (e) => { openFiles(e.target.files); e.target.value = ''; };
addEventListener('dragover', (e) => { e.preventDefault(); $('drop').style.display = 'flex'; });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('drop').style.display = 'none'; });
addEventListener('drop', (e) => { e.preventDefault(); $('drop').style.display = 'none'; openFiles(e.dataTransfer.files); });

/* ---------- settings ---------- */
function applyFinish() {
  if (!book) return;
  const f = FINISH[state.finish];
  book.leaves.forEach((L) => L.mesh.material.forEach((m) => {
    m.roughness = f.roughness; m.clearcoat = f.clearcoat; m.clearcoatRoughness = f.clearcoatRoughness; m.bumpScale = f.bump; m.needsUpdate = true;
  }));
}
$('paper').onchange = (e) => { state.finish = e.target.value; applyFinish(); };
$('gsm').onchange = (e) => {
  state.gsm = +e.target.value;
  if (book) { book.gap = GSM[state.gsm].gap; update(); }
};
$('bg').onchange = (e) => setBackground(e.target.value);
$('cam').onchange = (e) => applyCamera(e.target.value);
$('pages').onchange = (e) => { state.spreads = e.target.value === 'spreads'; load(); };
$('save').onclick = () => {
  renderer.render(scene, camera);
  renderer.domElement.toBlob((b) => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(b);
    a.download = `booklet-preview-${Date.now()}.png`; a.click();
  });
};

/* ---------- sample booklet ---------- */
function makeSample() {
  const PW = 1000, PH = 1414, OR = '#F4501E', BK = '#111', CR = '#f2eee6';
  const pages = [];
  const mk = (bg, fn) => {
    const c = document.createElement('canvas'); c.width = PW; c.height = PH;
    const x = c.getContext('2d'); x.fillStyle = bg; x.fillRect(0, 0, PW, PH); fn(x); pages.push(c);
  };
  const F = (s, w = 700) => `${w} ${s}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const lorem = 'Print is a conversation between the page and the hand. Hold it up to the light and the stock tells you what it can carry: how it takes ink, how it falls open, where it wants to fold.';
  const wrap = (x, text, px, py, mw, lh) => {
    let line = '', y = py;
    for (const w of text.split(' ')) {
      const t = line + w + ' ';
      if (x.measureText(t).width > mw && line) { x.fillText(line, px, y); line = w + ' '; y += lh; } else line = t;
    }
    x.fillText(line, px, y);
  };
  mk(OR, (x) => { x.fillStyle = BK; x.font = F(210, 800); x.fillText('THE', 70, 330); x.fillText('BOOK', 70, 530); x.fillText('LET', 70, 730);
    x.font = F(34, 600); x.fillText('SAMPLE BOOKLET — 16 PAGES', 70, PH - 80); });
  mk(BK, (x) => { x.fillStyle = OR; x.font = F(28, 600); x.fillText('INSIDE FRONT COVER', 70, 100); });
  mk(CR, (x) => { x.fillStyle = BK; x.font = F(440, 800); x.fillText('01', 50, 560); x.font = F(30, 500);
    x.fillText('Drop your own PDF to', 70, PH - 140); x.fillText('preview it here.', 70, PH - 100); });
  mk(CR, (x) => { x.fillStyle = BK; x.font = F(30, 500); wrap(x, lorem + ' ' + lorem, 70, 140, PW - 140, 46);
    x.fillStyle = OR; x.fillRect(70, 700, 400, 560); x.fillStyle = BK; x.fillRect(500, 700, 430, 270); });
  mk(BK, (x) => { const g = x.createLinearGradient(0, 0, PW, PH); g.addColorStop(0, OR); g.addColorStop(1, '#3a0d00');
    x.fillStyle = g; x.fillRect(0, 0, PW, PH); x.fillStyle = '#fff'; x.font = F(120, 800); x.fillText('FULL', 70, 1130); x.fillText('BLEED', 70, 1250); });
  mk(CR, (x) => { x.fillStyle = BK; x.font = F(26, 500);
    for (let c = 0; c < 2; c++) wrap(x, lorem + ' ' + lorem + ' ' + lorem, 70 + c * 440, 140, 400, 40);
    x.font = F(160, 800); x.fillStyle = OR; x.fillText('Aa', 70, 1180); });
  mk(OR, (x) => { x.fillStyle = BK; x.font = F(60, 800); x.fillText('A GRID', 70, 120);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) { x.fillStyle = (r + c) % 2 ? BK : CR; x.fillRect(70 + c * 290, 200 + r * 290, 270, 270); } });
  mk(CR, (x) => { x.fillStyle = BK; x.font = F(40, 700); x.fillText('Contents', 70, 140); x.font = F(30, 500);
    ['Intro', 'Stock', 'Colour', 'Type', 'Finish', 'Binding'].forEach((t, i) => { x.fillText(t, 70, 260 + i * 70); x.fillText(String(i * 2 + 3).padStart(2, '0'), 840, 260 + i * 70); }); });
  mk(BK, (x) => { x.fillStyle = CR; x.font = F(300, 800); x.fillText('09', 50, 560); });
  mk(OR, (x) => { x.fillStyle = BK; x.font = F(34, 600); wrap(x, 'Every spread is a stage. Mind the gutter, mind the bleed, and leave the white space alone.', 70, 200, 780, 56); });
  mk(CR, (x) => { x.fillStyle = BK; x.fillRect(70, 70, PW - 140, 700); x.fillStyle = OR; x.beginPath(); x.arc(500, 420, 220, 0, 7); x.fill();
    x.fillStyle = BK; x.font = F(26, 500); wrap(x, lorem, 70, 900, 700, 40); });
  mk(CR, (x) => { x.fillStyle = BK; x.font = F(26, 500); wrap(x, lorem + ' ' + lorem, 70, 140, 640, 40); x.font = F(30, 700); x.fillText('— 12', 70, PH - 80); });
  mk(BK, (x) => { x.fillStyle = OR; x.font = F(200, 800); x.fillText('FIN', 70, 560); });
  mk(OR, (x) => { x.fillStyle = BK; x.font = F(34, 600); x.fillText('THANK YOU', 70, 130); });
  mk(BK, (x) => { x.fillStyle = OR; x.font = F(28, 600); x.fillText('INSIDE BACK COVER', 70, 100); });
  mk(BK, (x) => { x.fillStyle = OR; x.fillRect(70, PH - 200, 120, 120); });
  return pages;
}

/* ---------- loop ---------- */
function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(view);

function frame() {
  const now = performance.now();
  if (tween) {
    const k = tween.dur ? Math.min(1, (now - tween.t0) / tween.dur) : 1;
    pos = tween.from + (tween.to - tween.from) * ease(k);
    if (k >= 1) { pos = tween.to; tween = null; }
    update();
  }
  if (camTween) {
    const k = Math.min(1, (now - camTween.t0) / 700);
    camera.position.lerpVectors(camTween.from, camTween.to, ease(k));
    if (k >= 1) camTween = null;
  }
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

const qs = new URLSearchParams(location.search);
if (qs.has('client')) document.body.classList.add('client');
for (const [k, id] of [['paper', 'paper'], ['gsm', 'gsm'], ['bg', 'bg']]) {
  if (qs.has(k)) { $(id).value = qs.get(k); if (k === 'paper') state.finish = qs.get(k); if (k === 'gsm') state.gsm = +qs.get(k); }
}
if (qs.get('spreads') === '1') { state.spreads = true; $('pages').value = 'spreads'; }
setBackground($('bg').value);
resize();
(async () => {
  const u = qs.get('pdf');
  if (u) {
    try {
      const r = await fetch(u);
      if (!r.ok) throw new Error(r.status);
      source = { kind: 'pdf', buf: await r.arrayBuffer(), name: qs.get('title') || u.split('/').pop() };
    } catch (e) { console.error('could not fetch', u, e); }
  }
  load();
})();
requestAnimationFrame(frame);
window.__pl = { goTo, get book() { return book; }, setPos(p) { tween = null; pos = target = p; update(); }, get pos() { return pos; } };
