/* Lighting presets for the 3D viewport (DESIGN_SPEC.md §5.3.3). Part of the lazy Three.js chunk.

   Every preset is expressed on one fixed rig of two directional lights. Switching presets mutates
   colour / intensity / position in place, so the scene's light count never changes: no allocation
   and no shader program recompiles. */

import * as THREE from "three";
import type { Lighting } from "../../stores/three";

/** Approximate sRGB of a black body at `kelvin` (Tanner Helland fit). */
export function kelvinToColor(kelvin: number): THREE.Color {
  const t = kelvin / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v: number) => Math.min(255, Math.max(0, v)) / 255;
  return new THREE.Color().setRGB(c(r), c(g), c(b), THREE.SRGBColorSpace);
}

interface LightSpec {
  color: THREE.Color;
  intensity: number;
  position: readonly [number, number, number];
}

interface Preset {
  lights: readonly [LightSpec, LightSpec];
  envIntensity: number;
}

const WHITE = new THREE.Color(1, 1, 1);

const PRESETS: Record<Lighting, Preset> = {
  studio: {
    lights: [
      { color: WHITE, intensity: 1.1, position: [-2.2, 3, 2.4] }, // soft key from front-left
      { color: WHITE, intensity: 0, position: [2.2, 2, -3] }, // unused: kept at zero
    ],
    envIntensity: 1.0,
  },
  warm: {
    lights: [
      { color: kelvinToColor(3200), intensity: 1.7, position: [-2.4, 2.6, 2.2] },
      { color: kelvinToColor(9000), intensity: 0.25, position: [2.6, 1.2, 1.4] }, // faint cool fill
    ],
    envIntensity: 0.7,
  },
  rim: {
    lights: [
      { color: WHITE, intensity: 2.2, position: [-2.2, 2.0, -3.0] },
      { color: WHITE, intensity: 2.2, position: [2.2, 2.0, -3.0] },
    ],
    envIntensity: 0.2,
  },
};

export interface LightRig {
  group: THREE.Group;
  lights: readonly [THREE.DirectionalLight, THREE.DirectionalLight];
}

export function createRig(): LightRig {
  const group = new THREE.Group();
  const lights = [new THREE.DirectionalLight(), new THREE.DirectionalLight()] as const;
  group.add(lights[0], lights[1]);
  return { group, lights };
}

/** Applies `preset` to the rig in place; returns the matching environment intensity. */
export function applyRig(rig: LightRig, preset: Lighting): number {
  const p = PRESETS[preset];
  for (let i = 0; i < 2; i++) {
    const spec = p.lights[i];
    const l = rig.lights[i];
    l.color.copy(spec.color);
    l.intensity = spec.intensity;
    l.position.set(spec.position[0], spec.position[1], spec.position[2]);
  }
  return p.envIntensity;
}

export function disposeRig(rig: LightRig): void {
  rig.group.removeFromParent();
  for (const l of rig.lights) l.dispose();
}
