import * as THREE from 'three';

/**
 * Give an instanced mesh its colour buffer now rather than on first use.
 *
 * `InstancedMesh.setColorAt` creates `instanceColor` the first time it is
 * called, which is convenient and is a trap, because **the presence of that
 * buffer is part of the shader's identity**. A mesh with one compiles
 * `USE_INSTANCING_COLOR` and a mesh without it compiles something else, in the
 * colour pass and in the shadow pass alike.
 *
 * That is why one shader program kept compiling in the middle of a round after
 * the boot-time warm-up had supposedly compiled everything. The warm-up is
 * thorough — it forces every hidden object visible and lifts every zero
 * `count`, so the whole cast is drawn — but on a title screen no kid has been
 * *coloured* yet, so every character mesh still had `instanceColor === null`.
 * The warm-up dutifully compiled the no-instance-colour variant of each, and
 * the first time a kid was posed the real one had to be compiled after all.
 * Four browser probes went looking for a missing object; nothing was missing,
 * and the object was in a different shape than it would later be.
 *
 * So the buffer is allocated up front, which makes an instanced mesh look the
 * same to the compiler at boot as it will in the tenth minute of a round. It
 * also removes a buffer allocation from the frame that first colours anybody,
 * which was its own small hitch.
 *
 * **Filled with white**, because white is the identity for a multiply: an
 * instance nobody has coloured draws exactly as it did before this existed.
 * The alternative — leaving it zeroed — would paint every unset instance black
 * and would be a far more visible bug than the stutter this removes.
 */
export function giveInstanceColor<T extends THREE.InstancedMesh>(mesh: T): T {
  // Idempotent. A caller that cannot easily tell whether a mesh already has one
  // should not have to, and replacing a live buffer would throw away colours
  // somebody had already written into it.
  if (mesh.instanceColor !== null) return mesh;
  // Sized from the matrix rather than from `count`: `count` is what is being
  // drawn right now and is routinely zero, and a zero-length buffer is both
  // useless and something three refuses.
  const slots = mesh.instanceMatrix.count;
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(slots * 3).fill(1), 3);
  return mesh;
}
