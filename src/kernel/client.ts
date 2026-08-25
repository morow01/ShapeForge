import * as Comlink from "comlink";
import type { KernelAPI } from "./worker";

const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});

export const kernel = Comlink.wrap<KernelAPI>(worker);
