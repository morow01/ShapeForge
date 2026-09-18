import * as THREE from "three";

const Z = new THREE.Vector3(0, 0, 1);
const DEG = Math.PI / 180;

export interface SurfaceOrientationInput {
  /** The source's rotation as it is now. */
  current: THREE.Quaternion;
  /** Outward normal of the face picked on the source, in the source's own
   *  frame, or null when no face was picked (its bottom goes on the surface). */
  face: THREE.Vector3 | null;
  /** Outward normal of the surface it is being placed on. */
  targetNormal: THREE.Vector3;
  /** Spin about the contact, and tilt about the two axes across it, in degrees. */
  angle: number;
  tiltX: number;
  tiltY: number;
}

/**
 * The rotation the source ends up with when it is placed on a surface.
 *
 * With a face picked, the rotation is the SMALLEST turn from the source's
 * current orientation that lays that face flat against the surface. Nothing
 * else about the object changes: if it already sits so that its face looks
 * away from the surface, it does not turn at all. It used to be rebuilt from
 * the mesh's own axes, ignoring how the object was oriented, so an object that
 * had been rotated came out spun a quarter turn about the contact.
 */
export function surfaceOrientation(input: SurfaceOrientationInput): THREE.Quaternion {
  const { current, face, targetNormal, angle, tiltX, tiltY } = input;
  // A frame whose +Z is the surface normal — where the tilt and spin act.
  const frame = new THREE.Quaternion().setFromUnitVectors(Z, targetNormal);
  const spinTilt = new THREE.Quaternion()
    .setFromAxisAngle(Z, angle * DEG)
    .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(tiltX * DEG, tiltY * DEG, 0)));
  const adjust = frame.clone().multiply(spinTilt);

  // No face picked: the bottom of the object goes on the surface.
  if (!face) return adjust;

  const facing = face.clone().applyQuaternion(current).normalize();
  const turn = new THREE.Quaternion().setFromUnitVectors(facing, targetNormal.clone().negate());
  return adjust.multiply(frame.clone().invert()).multiply(turn).multiply(current);
}
