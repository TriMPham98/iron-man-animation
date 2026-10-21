import * as THREE from 'three';
import { createAtmosphere, type Atmosphere } from './atmosphere';
import { Heightfield } from './heightfield';
import { Ocean } from './ocean';
import { Terrain } from './terrain';
import { Vegetation } from './vegetation';
import { buildHouse } from './house';
import { GARDEN } from './housePlants';
import { Clouds } from './clouds';
import { hazeAll } from '../render/haze';

/** Land, sea and sky, built once at boot. */
export class World {
  readonly field: Heightfield;
  readonly atmosphere: Atmosphere;
  readonly terrain: Terrain;
  readonly ocean: Ocean;
  readonly vegetation: Vegetation;
  readonly clouds: Clouds;
  /** 0–1: the eye is inside a cloud. */
  inCloud = 0;
  readonly group = new THREE.Group();
  time = 0;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    const t0 = performance.now();
    this.atmosphere = createAtmosphere(renderer, scene);
    const t1 = performance.now();
    this.field = Heightfield.generate(renderer);
    const t2 = performance.now();
    console.info(`[flight] sky ${Math.round(t1 - t0)} ms, heightfield ${Math.round(t2 - t1)} ms`);
    this.terrain = new Terrain(this.field, this.atmosphere.uniforms, this.field.texels);
    this.ocean = new Ocean(this.field, this.atmosphere.uniforms, renderer);
    this.vegetation = new Vegetation(this.field, this.atmosphere.uniforms, renderer);
    const { group: house, garden } = buildHouse(this.field);
    hazeAll(house, this.atmosphere.uniforms);
    this.vegetation.addGarden(GARDEN, garden);
    this.clouds = new Clouds(this.atmosphere.uniforms);
    this.group.add(this.terrain.group, this.ocean.mesh, this.vegetation.group, house, this.clouds.mesh);
    this.group.name = 'world';
    scene.add(this.group);
  }

  update(dt: number, camera: THREE.PerspectiveCamera): void {
    this.time += dt;
    this.terrain.update(camera, this.time);
    this.ocean.update(camera, this.time);
    this.vegetation.update(camera, this.time);
    this.inCloud = this.clouds.update(dt, camera);
  }
}
