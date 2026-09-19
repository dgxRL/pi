// Reduced from @earendil-works/chord. The real Context carries an abort signal,
// keyed values, and string identity; the reduced backend never reads any of it.
export interface Context {}

export const BACKGROUND_CONTEXT: Context = {};
