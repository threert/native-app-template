// Things that come and go (what a click drops): made once in setup and parked on a hidden shelf under the floor, then
// moved into place. Adding a mesh while the scene runs would make the renderer rebuild its scene (a hitch); moving
// one is free. The oldest comes back first when they run out.
import { BoxGeometry, type BufferGeometry, Mesh, type Scene, Vector3 } from "@threert/scene";

export class Pool {
  private readonly meshes: Mesh[] = [];
  private readonly homes: Vector3[] = [];
  private next = 0;
  private readonly zero = new Vector3();

  /** `count` meshes, taking turns among `kinds`, each a dynamic body with `physics` (mass, friction, restitution, ...). */
  constructor(scene: Scene, kinds: { geometry: BufferGeometry; material: Mesh["material"] }[], count: number, physics: object = {}) {
    const shelf = new Mesh(new BoxGeometry(count * 2 + 2, 1, 2), kinds[0]!.material);
    shelf.position.set(0, -20.5, 0);
    shelf.visible = false;
    shelf.physics = "fixed";
    scene.add(shelf);
    for (let k = 0; k < count; k++) {
      const kind = kinds[k % kinds.length]!;
      const mesh = new Mesh(kind.geometry, kind.material);
      mesh.name = `pool_${k}`;
      const home = new Vector3(-count + k * 2 + 1, -19.4, 0);
      mesh.position.copy(home);
      mesh.physics = { type: "dynamic", ...physics } as Mesh["physics"];
      scene.add(mesh);
      this.meshes.push(mesh);
      this.homes.push(home);
    }
  }

  /** The next one, at `at`, moving at `velocity`, turned and spinning by `spin` (radians, rad/s). */
  launch(at: Vector3, velocity: Vector3 = this.zero, spin = 0): Mesh {
    const mesh = this.meshes[this.next]!;
    this.next = (this.next + 1) % this.meshes.length;
    mesh.position.copy(at);
    mesh.rotation.set(spin * 1.3, spin * 2.1, spin * 0.7);
    mesh.setLinearVelocity(velocity);
    mesh.setAngularVelocity(new Vector3(spin, spin * 0.5, -spin));
    return mesh;
  }

  /** All of them back on the shelf. */
  clear(): void {
    this.meshes.forEach((mesh, k) => {
      mesh.position.copy(this.homes[k]!);
      mesh.rotation.set(0, 0, 0);
      mesh.setLinearVelocity(this.zero);
      mesh.setAngularVelocity(this.zero);
    });
    this.next = 0;
  }
}
