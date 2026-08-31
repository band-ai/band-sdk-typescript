// `@a2a-js/sdk` is the only optional peer that still needs an ambient declaration: it is
// the one peer not carried in devDependencies, so nothing resolves its types at build
// time and `import` from it would not compile. Every other optional peer is a
// devDependency typed by its own upstream declarations -- do not re-add entries here for
// those, because a body-less `declare module` silently widens the entire package to
// `any`, which is the erasure this file used to cause across eight SDKs.
declare module "@a2a-js/sdk";
declare module "@a2a-js/sdk/client";
declare module "@a2a-js/sdk/server";
declare module "@a2a-js/sdk/server/express";
