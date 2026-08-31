// `@google/adk` publishes no type declarations and is not carried in devDependencies, so
// this ambient declaration is what makes the dynamic import resolve at all. It widens the
// package to `any`; the adapter compensates with local shims that name that reason.
declare module "@google/adk";
