// `@a2a-js/sdk` is the only optional peer that still needs an ambient declaration: it is
// not carried in devDependencies and the published package ships no usable type
// declarations, so `import type` from it cannot resolve. Every other optional peer is in
// devDependencies and is typed by its own upstream declarations -- do not re-add entries
// here for those, because a body-less `declare module` silently widens the whole package
// to `any`.
declare module "@a2a-js/sdk";
declare module "@a2a-js/sdk/client";
declare module "@a2a-js/sdk/server";
declare module "@a2a-js/sdk/server/express";
