import { ValidationError } from "../../core/errors";

/**
 * The canonical identity of the platform a durable journal is bound to: the
 * canonical HTTP(S) REST base URL — scheme and host lowercased, default port
 * dropped, a meaningful base path kept. The identity is namespaced into the
 * journal's file layout and written into every journal's header, so it must
 * be stable for the life of a deployment.
 *
 * It never carries credentials, a query token or a fragment: those would leak
 * secrets into journal files, and a token-bearing endpoint would otherwise be
 * folded into the identity of the deployment behind it.
 */
export function canonicalPlatformIdentity(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ValidationError("A journal platform identity must be an HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError("A journal platform identity must use the http or https scheme");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ValidationError("A journal platform identity must not carry credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ValidationError("A journal platform identity must not carry a query string or fragment");
  }
  if (url.hostname === "") {
    throw new ValidationError("A journal platform identity must name a host");
  }
  // `URL` already drops default ports (443/80) and lowercases scheme and host.
  const host = url.port === "" ? url.hostname : `${url.hostname}:${url.port}`;
  // A bare root path, and any trailing slash, are not a meaningful base path.
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${host}${path}`;
}