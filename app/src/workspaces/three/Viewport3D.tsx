/* Three.js viewport (DESIGN_SPEC.md §5.3.3) — loaded lazily, only when the 3D workspace is visited.
   Renders on demand: a frame is drawn only for control changes, damping, auto-rotate, camera tweens,
   resizes or setting changes. When untouched — or while the window is hidden/minimised, even with
   auto-rotate on — no animation frame is scheduled. */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { useThreeStore, type Lighting, type Shading } from "../../stores/three";
import { applyRig, createRig, disposeRig } from "./lighting";
import { viewportBus, type CameraPreset } from "./viewportBus";

const FOV = 35;
const MARGIN = 1.35;
const TWEEN_MS = 450;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

function cssColor(name: string): { color: THREE.Color; alpha: number } {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = raw.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b, a] = m[1].split(",").map((s) => parseFloat(s));
    return { color: new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace), alpha: Number.isFinite(a) ? a : 1 };
  }
  const c = new THREE.Color();
  try {
    if (raw) c.setStyle(raw, THREE.SRGBColorSpace);
  } catch {
    /* keep default */
  }
  return { color: c, alpha: 1 };
}

/** Every GPU/decoded resource a loaded GLB owns, collected once so it can be released exactly once. */
interface SceneResources {
  geometries: Set<THREE.BufferGeometry>;
  materials: Set<THREE.Material>;
  textures: Set<THREE.Texture>;
  bitmaps: Set<ImageBitmap>;
}

function collectResources(root: THREE.Object3D, exclude: ReadonlySet<THREE.Material>): SceneResources {
  const res: SceneResources = { geometries: new Set(), materials: new Set(), textures: new Set(), bitmaps: new Set() };
  const addTexture = (t: THREE.Texture) => {
    if (res.textures.has(t)) return;
    res.textures.add(t);
    const data: unknown = t.source?.data ?? t.image;
    if (typeof ImageBitmap !== "undefined" && data instanceof ImageBitmap) res.bitmaps.add(data);
  };
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry instanceof THREE.BufferGeometry) res.geometries.add(m.geometry);
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const mat of mats) {
      if (exclude.has(mat) || res.materials.has(mat)) continue;
      res.materials.add(mat);
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) addTexture(v);
      const uniforms = (mat as THREE.ShaderMaterial).uniforms;
      if (uniforms) for (const u of Object.values(uniforms)) if (u?.value instanceof THREE.Texture) addTexture(u.value);
    }
  });
  return res;
}

function disposeResources(res: SceneResources): void {
  res.geometries.forEach((g) => g.dispose());
  res.textures.forEach((t) => t.dispose());
  res.materials.forEach((m) => m.dispose());
  // Texture.dispose() frees the GL texture but never closes the decoded ImageBitmap source.
  res.bitmaps.forEach((b) => b.close());
  res.geometries.clear();
  res.textures.clear();
  res.materials.clear();
  res.bitmaps.clear();
}

class ViewportEngine {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
  private readonly controls: OrbitControls;
  private readonly pmrem: THREE.PMREMGenerator;
  /** PMREM render target behind `scene.environment`; owned here and disposed on unmount. */
  private readonly envTarget: THREE.WebGLRenderTarget;
  /** Fixed two-light rig; presets mutate it in place (no shader recompiles). */
  private readonly rig = createRig();
  private readonly loader = new GLTFLoader();
  private model: THREE.Object3D | null = null;
  private modelResources: SceneResources | null = null;
  /** Contact shadow: one shared unit quad + gradient texture, scaled to each model's footprint. */
  private readonly shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private wireOverlays: THREE.Mesh[] = [];
  private readonly clayMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  private readonly normalMat = new THREE.MeshNormalMaterial();
  private readonly wireMat = new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, depthWrite: false });
  private readonly ownMaterials: ReadonlySet<THREE.Material> = new Set<THREE.Material>([this.clayMat, this.normalMat, this.wireMat]);
  private shading: Shading = "pbr";
  private radius = 0.6;
  private center = new THREE.Vector3(0, 0.5, 0);
  private raf = 0;
  private last = 0;
  private active = true;
  private visible = !document.hidden;
  private pointerDown = false;
  private autoRotate = false;
  private tween: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t0: number } | null = null;
  private settle: { t0: number } | null = null;
  private disposed = false;
  private loadSeq = 0;
  private readonly loopBound = (t: number) => this.loop(t);
  private readonly onChange = () => this.requestRender();
  private readonly onStart = () => {
    this.pointerDown = true;
    this.controls.autoRotate = false;
  };
  private readonly onEnd = () => {
    this.pointerDown = false;
    this.controls.autoRotate = this.autoRotate;
    this.requestRender();
  };
  private readonly onDblClick: (e: MouseEvent) => void;
  private readonly onVisibility = () => {
    this.visible = !document.hidden;
    if (this.visible) this.requestRender();
    else this.stopLoop();
  };

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envTarget = this.pmrem.fromScene(room, 0.04);
    room.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
    });
    this.scene.environment = this.envTarget.texture;

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.autoRotateSpeed = 1.5; // one turn per 40 s with update(deltaSeconds)
    this.controls.keys = { LEFT: "", UP: "", RIGHT: "", BOTTOM: "" };
    this.controls.addEventListener("change", this.onChange);
    this.controls.addEventListener("start", this.onStart);
    this.controls.addEventListener("end", this.onEnd);

    this.onDblClick = (e: MouseEvent) => {
      if (!this.model) return;
      const r = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObject(this.model, true)[0];
      if (hit) this.tweenTo(this.camera.position.clone().add(hit.point.clone().sub(this.controls.target)), hit.point.clone());
    };
    canvas.addEventListener("dblclick", this.onDblClick);
    document.addEventListener("visibilitychange", this.onVisibility);

    this.scene.add(this.rig.group);
    this.shadow = this.createShadow();
    this.scene.add(this.shadow);

    this.refreshTheme();
    this.frame(true);
    this.requestRender();
  }

  // ───────── Rendering on demand ─────────

  requestRender(): void {
    if (this.raf || !this.active || !this.visible || this.disposed) return;
    this.raf = requestAnimationFrame(this.loopBound);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
  }

  private loop(now: number): void {
    this.raf = 0;
    if (!this.active || !this.visible || this.disposed) return;
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    let more = false;
    if (this.tween) {
      const t = Math.min(1, (performance.now() - this.tween.t0) / TWEEN_MS);
      const k = easeOut(t);
      this.camera.position.lerpVectors(this.tween.from, this.tween.to, k);
      this.controls.target.lerpVectors(this.tween.tFrom, this.tween.tTo, k);
      if (t >= 1) this.tween = null;
      else more = true;
    }
    if (this.settle && this.model) {
      const t = Math.min(1, (performance.now() - this.settle.t0) / 300);
      this.model.rotation.y = THREE.MathUtils.degToRad(-15) * (1 - easeOut(t));
      if (t >= 1) this.settle = null;
      else more = true;
    }
    const changed = this.controls.update(dt);
    if (changed) more = true;
    if (this.controls.autoRotate) more = true;
    this.renderer.render(this.scene, this.camera);
    if (more) {
      if (!this.raf) this.raf = requestAnimationFrame(this.loopBound);
    } else {
      this.last = 0;
    }
  }

  setActive(a: boolean): void {
    this.active = a;
    if (a) this.requestRender();
    else this.stopLoop();
  }

  resize(w: number, h: number): void {
    if (w < 2 || h < 2) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  refreshTheme(): void {
    const clay = cssColor("--clay");
    this.clayMat.color.copy(clay.color);
    const wire = cssColor("--wire");
    this.wireMat.color.copy(wire.color);
    this.wireMat.opacity = wire.alpha;
    this.requestRender();
  }

  // ───────── Model ─────────

  async load(url: string | null, onLoaded: () => void): Promise<void> {
    const seq = ++this.loadSeq;
    if (!url) {
      this.unloadModel();
      this.requestRender();
      return;
    }
    const gltf = await this.loader.loadAsync(url);
    const root = gltf.scene;
    // Collect before any shading swap so exactly the GLB's own resources are tracked.
    const resources = collectResources(root, this.ownMaterials);
    if (seq !== this.loadSeq || this.disposed) {
      // Superseded or unmounted mid-load: release everything this load decoded/uploaded.
      disposeResources(resources);
      return;
    }
    this.unloadModel();
    this.modelResources = resources;
    // One bounds pass: re-centring is a pure translation of the root, so the box moves with it.
    const box = new THREE.Box3().setFromObject(root);
    const c = box.getCenter(new THREE.Vector3());
    const offset = new THREE.Vector3(-c.x, -box.min.y, -c.z);
    root.position.add(offset);
    root.updateMatrixWorld(true);
    const sized = box.translate(offset);
    const sphere = sized.getBoundingSphere(new THREE.Sphere());
    this.radius = Math.max(0.05, sphere.radius);
    this.center.copy(sphere.center);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) this.originals.set(m, m.material);
    });
    this.model = root;
    root.rotation.y = THREE.MathUtils.degToRad(-15);
    this.scene.add(root);
    this.placeShadow(sized);
    this.applyShading(this.shading);
    this.frame(true);
    this.settle = { t0: performance.now() };
    onLoaded();
    this.requestRender();
  }

  private createShadow(): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
    const tex = document.createElement("canvas");
    tex.width = tex.height = 128;
    const g = tex.getContext("2d")!;
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, "rgba(0,0,0,0.32)");
    grad.addColorStop(0.55, "rgba(0,0,0,0.12)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(tex);
    t.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, toneMapped: false }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.001;
    mesh.renderOrder = -1;
    mesh.visible = false;
    return mesh;
  }

  private placeShadow(box: THREE.Box3): void {
    const size = box.getSize(new THREE.Vector3());
    const d = Math.max(size.x, size.z) * 1.5 || 1;
    this.shadow.scale.set(d, d, 1); // the quad lies in its local XY plane
    this.shadow.visible = true;
  }

  private unloadModel(): void {
    this.clearWire();
    if (this.model) {
      this.scene.remove(this.model);
      this.originals.forEach((mat, mesh) => (mesh.material = mat));
      this.model = null;
    }
    if (this.modelResources) {
      disposeResources(this.modelResources);
      this.modelResources = null;
    }
    this.originals.clear();
    this.shadow.visible = false;
  }

  private clearWire(): void {
    for (const w of this.wireOverlays) w.parent?.remove(w);
    this.wireOverlays = [];
  }

  applyShading(s: Shading): void {
    this.shading = s;
    this.clearWire();
    this.originals.forEach((orig, mesh) => {
      if (s === "pbr") mesh.material = orig;
      else if (s === "normals") mesh.material = this.normalMat;
      else mesh.material = this.clayMat;
      if (s === "wireframe") {
        const w = new THREE.Mesh(mesh.geometry, this.wireMat);
        w.renderOrder = 1;
        mesh.add(w);
        this.wireOverlays.push(w);
      }
    });
    this.requestRender();
  }

  applyLighting(l: Lighting): void {
    this.scene.environmentIntensity = applyRig(this.rig, l);
    this.requestRender();
  }

  setExposure(v: number): void {
    this.renderer.toneMappingExposure = v;
    this.requestRender();
  }

  setAutoRotate(v: boolean): void {
    this.autoRotate = v;
    this.controls.autoRotate = v && !this.pointerDown;
    this.requestRender();
  }

  // ───────── Camera ─────────

  private fitDistance(): number {
    return (this.radius * MARGIN) / Math.sin(THREE.MathUtils.degToRad(FOV / 2));
  }

  private dirFor(p: CameraPreset): THREE.Vector3 {
    switch (p) {
      case "front":
        return new THREE.Vector3(0, 0, 1);
      case "side":
        return new THREE.Vector3(1, 0, 0);
      case "top":
        return new THREE.Vector3(0, 1, 0.0001).normalize();
      case "iso":
      case "reset": {
        const az = THREE.MathUtils.degToRad(35);
        const el = THREE.MathUtils.degToRad(25);
        return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
      }
    }
  }

  private frame(instant: boolean, preset: CameraPreset = "reset"): void {
    const d = this.fitDistance();
    this.controls.minDistance = d * 0.25;
    this.controls.maxDistance = d * 8;
    this.camera.near = Math.max(0.001, d / 200);
    this.camera.far = d * 20;
    this.camera.updateProjectionMatrix();
    const to = this.center.clone().add(this.dirFor(preset).multiplyScalar(d));
    if (instant) {
      this.camera.position.copy(to);
      this.controls.target.copy(this.center);
      this.controls.update();
      this.requestRender();
    } else this.tweenTo(to, this.center.clone());
  }

  private tweenTo(pos: THREE.Vector3, target: THREE.Vector3): void {
    this.tween = { from: this.camera.position.clone(), to: pos, tFrom: this.controls.target.clone(), tTo: target, t0: performance.now() };
    this.requestRender();
  }

  preset(p: CameraPreset): void {
    this.frame(false, p);
  }

  dispose(): void {
    this.disposed = true;
    this.stopLoop();
    this.canvas.removeEventListener("dblclick", this.onDblClick);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.controls.removeEventListener("change", this.onChange);
    this.controls.removeEventListener("start", this.onStart);
    this.controls.removeEventListener("end", this.onEnd);
    this.controls.dispose();
    this.unloadModel();
    disposeRig(this.rig);
    this.scene.remove(this.shadow);
    this.shadow.geometry.dispose();
    this.shadow.material.map?.dispose();
    this.shadow.material.dispose();
    this.clayMat.dispose();
    this.normalMat.dispose();
    this.wireMat.dispose();
    this.scene.environment = null;
    this.envTarget.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

export interface Viewport3DProps {
  glbUrl: string | null;
  active: boolean;
  dimmed: boolean;
  onLoaded(): void;
  onError(): void;
}

export default function Viewport3D({ glbUrl, active, dimmed, onLoaded, onError }: Viewport3DProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const engine = useRef<ViewportEngine | null>(null);
  const shading = useThreeStore((s) => s.shading);
  const lighting = useThreeStore((s) => s.lighting);
  const exposure = useThreeStore((s) => s.exposure);
  const autoRotate = useThreeStore((s) => s.autoRotate);
  const cb = useRef({ onLoaded, onError });
  cb.current = { onLoaded, onError };

  useEffect(() => {
    // A fresh canvas per mount: a disposed renderer leaves its canvas with a lost context.
    const c = document.createElement("canvas");
    c.setAttribute("aria-hidden", "true");
    c.className = "block h-full w-full";
    c.style.transition = "opacity var(--dur-reveal) var(--ease-out)";
    c.style.touchAction = "none";
    wrap.current!.appendChild(c);
    canvas.current = c;
    const e = new ViewportEngine(c);
    engine.current = e;
    // Shading / lighting / exposure / auto-rotate are applied by the setting effects below, which
    // run in this same commit right after this one.
    const el = wrap.current!;
    const ro = new ResizeObserver(() => e.resize(el.clientWidth, el.clientHeight));
    ro.observe(el);
    const obs = new MutationObserver(() => e.refreshTheme());
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const detach = viewportBus.attach({ preset: (p) => e.preset(p), reframe: () => e.preset("reset") });
    return () => {
      detach();
      obs.disconnect();
      ro.disconnect();
      e.dispose();
      c.remove();
      canvas.current = null;
      engine.current = null;
    };
  }, []);

  useEffect(() => engine.current?.setActive(active), [active]);
  useEffect(() => engine.current?.applyShading(shading), [shading]);
  useEffect(() => engine.current?.applyLighting(lighting), [lighting]);
  useEffect(() => engine.current?.setExposure(exposure), [exposure]);
  useEffect(() => engine.current?.setAutoRotate(autoRotate), [autoRotate]);

  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    const c = canvas.current!;
    if (glbUrl) c.style.opacity = "0";
    e.load(glbUrl, () => {
      c.style.opacity = "1";
      cb.current.onLoaded();
    }).catch(() => {
      c.style.opacity = "1";
      cb.current.onError();
    });
  }, [glbUrl]);

  return (
    <div ref={wrap} className="absolute inset-0" style={{ opacity: dimmed ? 0.35 : 1, transition: "opacity var(--dur-base) var(--ease-out)" }} />
  );
}
