import * as THREE from "three";

/** Screen-space ground: no finite plane, depth offset, or camera far-plane limit. */
export function createInfiniteGrid(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  const material = new THREE.ShaderMaterial({
    precision: "highp",
    uniforms: {
      inverseProjection: { value: new THREE.Matrix4() },
      cameraWorld: { value: new THREE.Matrix4() },
      centre: { value: new THREE.Vector2() },
      viewSpan: { value: 256 },
      pixelHeight: { value: 800 },
      orthographic: { value: false },
    },
    vertexShader: `
      varying vec2 screen;
      void main() {
        screen = position.xy;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform mat4 inverseProjection;
      uniform mat4 cameraWorld;
      uniform vec2 centre;
      uniform float viewSpan;
      uniform float pixelHeight;
      uniform bool orthographic;
      varying vec2 screen;

      float grid(vec2 ground, float spacing) {
        vec2 cell = ground / spacing;
        // Filter each direction separately. A grazing angle must not inflate
        // the perpendicular lines or turn unresolved cells into dark bands.
        vec2 dx = dFdx(cell);
        vec2 dy = dFdy(cell);
        vec2 footprint = max(sqrt(dx * dx + dy * dy), vec2(0.000001));
        vec2 distanceToLine = abs(fract(cell - 0.5) - 0.5);
        // A one-pixel line with a one-pixel antialiasing ramp, measured
        // perpendicular to the line (fwidth makes diagonals unnecessarily soft).
        vec2 coverage = 1.0 - smoothstep(vec2(0.0), vec2(1.0), distanceToLine / footprint);
        coverage *= 1.0 - smoothstep(vec2(0.08), vec2(0.35), footprint);
        return max(coverage.x, coverage.y);
      }

      void main() {
        vec4 view = inverseProjection * vec4(screen, -1.0, 1.0);
        vec3 viewPoint = view.xyz / view.w;
        vec3 start = orthographic
          ? (cameraWorld * vec4(viewPoint, 1.0)).xyz
          : cameraWorld[3].xyz;
        // Rotate a view-space direction directly. Subtracting two world-space
        // points only 0.1 mm apart loses precision when the camera is far away,
        // producing the broken, fuzzy lines seen on large zoom-outs.
        vec3 direction = normalize(mat3(cameraWorld) * (orthographic ? vec3(0.0, 0.0, -1.0) : viewPoint));
        if (abs(direction.z) < 0.00001) discard;
        float t = -start.z / direction.z;
        if (!orthographic && t <= 0.0) discard;
        vec2 ground = (start + t * direction).xy;
        // Keep roughly 40 pixels between lines; decade transitions are
        // continuous, with the next scale already present as major lines.
        float level = max(0.0, log(max(viewSpan / pixelHeight * 40.0 / 8.0, 1.0)) / log(10.0));
        float spacing = 8.0 * pow(10.0, floor(level));
        float blend = smoothstep(0.0, 1.0, fract(level));
        float fine = grid(ground, spacing);
        float major = grid(ground, spacing * 10.0);
        float coarse = grid(ground, spacing * 100.0);
        float ink = mix(max(fine * 0.38, major * 0.62), max(major * 0.38, coarse * 0.62), blend);
        float radius = max(viewSpan * 4.0, 256.0);
        float fade = 1.0 - smoothstep(radius * 0.25, radius, length(ground - centre));
        gl_FragColor = vec4(vec3(0.48, 0.55, 0.60), ink * fade);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    depthTest: false,
    depthWrite: false,
    // Stay in the opaque queue, ahead of solid and transparent model geometry.
    transparent: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10000;
  mesh.raycast = () => {};
  const drawingSize = new THREE.Vector2();
  mesh.onBeforeRender = (renderer, _scene, camera) => {
    material.uniforms.inverseProjection.value.copy(camera.projectionMatrixInverse);
    material.uniforms.cameraWorld.value.copy(camera.matrixWorld);
    material.uniforms.orthographic.value = camera instanceof THREE.OrthographicCamera;
    renderer.getDrawingBufferSize(drawingSize);
    material.uniforms.pixelHeight.value = Math.max(1, drawingSize.y);
  };
  return mesh;
}
