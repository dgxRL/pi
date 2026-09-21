// Opaque invocation context marker, reduced from @earendil-works/chord.
// Storage implementations never read it; signatures keep it for fidelity.

export interface Context {}

export const BACKGROUND_CONTEXT: Context = {};
