// Reduced barrel: the streaming contract, the event spine, and the faux
// provider registered into the minimal registry. No HTTP wire protocol.

export { Type, type Static, type TSchema } from "typebox";
export * from "./types.ts";
export * from "./event-stream.ts";
export * from "./json-parse.ts";
export * from "./registry.ts";
export * from "./faux.ts";
