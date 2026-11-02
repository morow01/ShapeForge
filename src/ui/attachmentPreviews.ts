import { attachmentBytes, attachmentPreview, saveAttachmentPreview } from '../document/attachments';
import type { Attachment } from '../document/attachments';

const WIDTH = 480, HEIGHT = 320;
// The queue avoids creating many WebGL contexts or parsing several models at once.
let queue = Promise.resolve();
const pending = new Map<string, Promise<string | null>>();
export function fileExtension(name: string): string { return name.split('.').length > 1 ? name.split('.').pop()!.toLowerCase() : ''; }
export function supportsPreview(name: string): boolean { return /^(stl|3mf|pdf|txt|md|csv|log|json|yaml|yml|ini|gcode|png|jpg|jpeg|webp|gif)$/.test(fileExtension(name)); }
function canvas() {
  const el = document.createElement('canvas'); el.width = WIDTH; el.height = HEIGHT;
  const ctx = el.getContext('2d'); if (!ctx) throw new Error('Image previews are unavailable.');
  ctx.fillStyle = '#eef2f5'; ctx.fillRect(0, 0, WIDTH, HEIGHT);
  return { el, ctx };
}
async function imagePreview(bytes: ArrayBuffer, mimeType: string): Promise<string> {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
  try {
    const { el, ctx } = canvas();
    const fit = Math.min(WIDTH / bitmap.width, HEIGHT / bitmap.height);
    const w = bitmap.width * fit, h = bitmap.height * fit;
    ctx.drawImage(bitmap, (WIDTH-w)/2, (HEIGHT-h)/2, w, h);
    return el.toDataURL('image/png');
  } finally { bitmap.close(); }
}
function textPreview(bytes: ArrayBuffer): string {
  const text = new TextDecoder().decode(bytes.slice(0, 12000));
  if (text.includes('\0')) throw new Error('This file does not contain readable text.');
  const { el, ctx } = canvas();
  ctx.fillStyle = '#fff'; ctx.fillRect(34, 16, WIDTH-68, HEIGHT-32);
  ctx.fillStyle = '#334155'; ctx.font = '14px monospace';
  let row = 0;
  for (const line of text.replace(/\t/g, '  ').split(/\r?\n/)) {
    const chunks = line.match(/.{1,43}/gu) ?? [''];
    for (const chunk of chunks) { ctx.fillText(chunk, 49, 42 + 19 * row++); if (row >= 14) return el.toDataURL('image/png'); }
  }
  return el.toDataURL('image/png');
}
async function pdfPreview(bytes: ArrayBuffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: bytes.slice(0), useSystemFonts: true });
  task.onPassword = (_updatePassword: (password: string) => void, _reason: number) => { void task.destroy(); };
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const natural = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min((WIDTH-24)/natural.width, (HEIGHT-24)/natural.height) });
    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = Math.ceil(viewport.width); pageCanvas.height = Math.ceil(viewport.height);
    await page.render({ canvas: pageCanvas, viewport }).promise;
    const { el, ctx } = canvas(); ctx.drawImage(pageCanvas, (WIDTH-pageCanvas.width)/2, (HEIGHT-pageCanvas.height)/2);
    return el.toDataURL('image/png');
  } finally { await task.destroy(); }
}

let renderer: import('three').WebGLRenderer | null = null;
async function modelPreview(bytes: ArrayBuffer, ext: string): Promise<string> {
  // Prefer a slicer's own preview: it includes colours and plate layout.
  if (ext === '3mf') {
    const { unzipSync } = await import('fflate');
    const entries = unzipSync(new Uint8Array(bytes), { filter: entry => /(?:thumbnail|plate_1)\.(?:png|jpe?g)$/i.test(entry.name) && entry.originalSize < 4 * 1024 * 1024 });
    const key = Object.keys(entries).sort((a,b) => Number(!/thumbnail/i.test(a))-Number(!/thumbnail/i.test(b)))[0];
    if (key) {
      const data = entries[key];
      return imagePreview(data.slice().buffer as ArrayBuffer, /\.png$/i.test(key) ? 'image/png' : 'image/jpeg');
    }
  }
  if (bytes.byteLength > 40 * 1024 * 1024) throw new Error('This model is too large to render a thumbnail. Download to open it.');
  const THREE = await import('three');
  const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
  const geometries: import('three').BufferGeometry[] = [];
  try {
    if (ext === 'stl') geometries.push(new STLLoader().parse(bytes));
    else {
      const { parseThreeMF } = await import('../import/threemf');
      for (const part of parseThreeMF(bytes, 400000)) geometries.push(new STLLoader().parse(part.stl));
    }
    if (!geometries.length) throw new Error('This file has no printable mesh.');
    if (!renderer) {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
      renderer.setSize(WIDTH, HEIGHT); renderer.setPixelRatio(1); renderer.setClearColor('#eef2f5');
    }
    const scene = new THREE.Scene();
    const material = new THREE.MeshStandardMaterial({ color: '#52a8a5', metalness: 0.05, roughness: 0.65, side: THREE.DoubleSide });
    try {
      const group = new THREE.Group();
      for (const geometry of geometries) {
        geometry.computeBoundingBox();
        if (!geometry.boundingBox || !Number.isFinite(geometry.boundingBox.min.x)) continue;
        group.add(new THREE.Mesh(geometry, material));
      }
      const box = new THREE.Box3().setFromObject(group);
      if (box.isEmpty()) throw new Error('This model is empty.');
      const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
      group.position.sub(center); scene.add(group);
      const radius = Math.max(size.length()/2, 0.01);
      const cam = new THREE.OrthographicCamera(-radius*1.5, radius*1.5, radius, -radius, radius*0.01, radius*20);
      cam.up.set(0,0,1); cam.position.set(radius*3, -radius*4, radius*3); cam.lookAt(0,0,0);
      scene.add(new THREE.HemisphereLight('#ffffff', '#718096', 2.6));
      const light = new THREE.DirectionalLight('#ffffff', 3); light.position.set(radius*2,-radius*3,radius*5); scene.add(light);
      renderer.render(scene,cam);
      return renderer.domElement.toDataURL('image/png');
    } finally { material.dispose(); }
  } finally { geometries.forEach(g => g.dispose()); }
}
/** Original contents are immutable, so cached previews survive renames and moves. */
export function previewAttachment(file: Attachment, loadRemote?: () => Promise<ArrayBuffer>): Promise<string | null> {
  const existing = pending.get(file.id); if (existing) return existing;
  const job = queue.catch(() => {}).then(async () => {
    const cached = await attachmentPreview(file.id); if (cached) return cached;
    if (!supportsPreview(file.name)) return null;
    const ext = fileExtension(file.name);
    const limit = ext === 'stl' ? 40 : 150;
    if (file.size > limit * 1024 * 1024) throw new Error(`Preview unavailable for files larger than ${limit} MB. Download to open it.`);
    let bytes = await attachmentBytes(file.id);
    if (!bytes && loadRemote) {
      if (file.size > limit * 1024 * 1024) throw new Error('This file is too large for a preview.');
      bytes = await loadRemote();
    }
    if (!bytes) return null;
    // Large attachments stay usable; previews must not exhaust the editor's memory.
    if (bytes.byteLength > limit * 1024 * 1024) throw new Error('This file is too large for a preview.');
    const result = ext === 'pdf' ? await pdfPreview(bytes)
      : ext === 'stl' || ext === '3mf' ? await modelPreview(bytes, ext)
      : /^(png|jpg|jpeg|webp|gif)$/.test(ext) ? await imagePreview(bytes, file.mimeType)
      : textPreview(bytes);
    await saveAttachmentPreview(file.id, result); return result;
  });
  queue = job.then(() => {}, () => {});
  pending.set(file.id,job);
  void job.finally(() => pending.delete(file.id)).catch(() => {});
  return job;
}
