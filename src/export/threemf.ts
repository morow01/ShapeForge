import { zipSync } from "fflate";

/** One printable body, already evaluated and meshed by the kernel. */
export interface ThreeMFObject {
  name: string;
  /** "#rrggbb". Written as a base material so slicers show the part in the
   *  colour it had on screen. */
  color: string;
  /** Flat xyz triples, millimetres. */
  vertices: ArrayLike<number>;
  /** Flat index triples into `vertices`. */
  triangles: ArrayLike<number>;
}

/** XML text nodes and attribute values must not carry raw markup. Object names
 *  come from the user, so they can contain anything. */
function xmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 3MF wants #RRGGBBAA. Anything unreadable falls back to opaque grey rather
 *  than writing an attribute a slicer would reject. */
function colorAttribute(color: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  return `#${(hex ? hex[1] : "b0b6ba").toUpperCase()}FF`;
}

/**
 * Writes the 3MF package: a ZIP holding the content-type map, a relationship
 * pointing at the model, and the model itself.
 *
 * Why bother, when STL already works: an STL states no units at all, so
 * "20" is 20 of whatever the slicer decides — the classic way a part arrives
 * 25.4x too big. 3MF says `unit="millimeter"` outright. It also keeps each
 * object separate instead of fusing the scene into one body, carries a colour
 * per object, and indexes its vertices instead of repeating each one three
 * times per triangle, so the file is several times smaller.
 */
export function buildThreeMF(objects: ThreeMFObject[]): Blob {
  const printable = objects.filter((object) => object.triangles.length >= 3);
  const materials = printable
    .map((object) => `<base name="${xmlText(object.name)}" displaycolor="${colorAttribute(object.color)}" />`)
    .join("");

  const bodies = printable.map((object, index) => {
    const vertices: string[] = [];
    for (let i = 0; i + 2 < object.vertices.length; i += 3) {
      // 3MF is a text format, so unbounded float precision costs real file
      // size for detail below any printer's resolution. Six decimals is a
      // nanometre.
      vertices.push(
        `<vertex x="${+object.vertices[i].toFixed(6)}" y="${+object.vertices[i + 1].toFixed(6)}" z="${+object.vertices[i + 2].toFixed(6)}" />`,
      );
    }
    const triangles: string[] = [];
    for (let i = 0; i + 2 < object.triangles.length; i += 3) {
      triangles.push(
        `<triangle v1="${object.triangles[i]}" v2="${object.triangles[i + 1]}" v3="${object.triangles[i + 2]}" />`,
      );
    }
    // Object ids start at 2: id 1 is the base-materials group, and 3MF ids
    // share one namespace across resources.
    return (
      `<object id="${index + 2}" type="model" name="${xmlText(object.name)}" pid="1" pindex="${index}">` +
      `<mesh><vertices>${vertices.join("")}</vertices><triangles>${triangles.join("")}</triangles></mesh>` +
      `</object>`
    );
  });

  const items = printable.map((_, index) => `<item objectid="${index + 2}" />`).join("");

  const model =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="millimeter" xml:lang="en-US" ` +
    `xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<metadata name="Application">ShapeForge</metadata>` +
    `<resources>` +
    (materials ? `<basematerials id="1">${materials}</basematerials>` : "") +
    bodies.join("") +
    `</resources>` +
    `<build>${items}</build>` +
    `</model>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />` +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" ` +
    `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />` +
    `</Relationships>`;

  const encoder = new TextEncoder();
  const zipped = zipSync({
    "[Content_Types].xml": encoder.encode(contentTypes),
    "_rels/.rels": encoder.encode(rels),
    "3D/3dmodel.model": encoder.encode(model),
  });
  // Copy out of the (possibly pooled) fflate buffer before handing it on.
  return new Blob([new Uint8Array(zipped)], { type: "model/3mf" });
}
