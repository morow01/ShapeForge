// crypto.randomUUID only exists on secure pages (https:// or localhost). Opening the
// dev server from another device by its network address (http://192.168.x.x:5173,
// e.g. a tablet) is not secure, so creating any object threw
// "crypto.randomUUID is not a function". getRandomValues has no such restriction.
if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
  (crypto as { randomUUID: () => string }).randomUUID = () => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
    return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10).join("")}`;
  };
}
