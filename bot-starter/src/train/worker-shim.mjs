// Los workers no heredan el loader de tsx: lo registramos a mano.
import { register } from "tsx/esm/api";
register();
await import("./worker.ts");
