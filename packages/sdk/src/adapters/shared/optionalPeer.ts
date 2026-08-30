import { asErrorMessage, UnsupportedFeatureError } from "../../core/errors";

export interface LoadOptionalPeerOptions<T> {
  /** Adapter (or adapter feature) that needs the peer, used to open the diagnostic. */
  feature: string;
  /** Package name as it appears in `peerDependencies`, quoted in the diagnostic. */
  packageName: string;
  /**
   * Extra qualifier appended to the feature, e.g. `"when MCP tools are enabled"`, for
   * peers that are only needed on some code paths.
   */
  condition?: string;
  /**
   * Imports the peer. Must contain a literal `import()` so bundlers keep the specifier
   * external rather than trying to resolve it at build time.
   */
  importModule: () => Promise<unknown>;
  /**
   * Narrows the loaded module to the shape the caller needs, or returns `undefined` when
   * the installed version does not export it.
   */
  select: (module: Record<string, unknown>) => T | undefined;
  /** What `select` looked for, named in the diagnostic when it returns `undefined`. */
  expectedExports: string;
}

function requirement(feature: string, packageName: string, condition?: string): string {
  const qualifier = condition ? ` ${condition}` : "";
  return `${feature} requires optional dependency "${packageName}"${qualifier}.`;
}

/**
 * Loads an optional peer dependency behind one diagnostic. A missing package produces an
 * `UnsupportedFeatureError` naming the package and an install hint, with the underlying
 * import failure attached as `cause`; an installed-but-incompatible package produces one
 * naming the missing exports instead — an install hint there would be misleading, since
 * the package is already present.
 */
export async function loadOptionalPeer<T>(options: LoadOptionalPeerOptions<T>): Promise<T> {
  const { feature, packageName, condition } = options;

  let module: Record<string, unknown>;
  try {
    module = (await options.importModule()) as Record<string, unknown>;
  } catch (error) {
    throw new UnsupportedFeatureError(
      `${requirement(feature, packageName, condition)} Install it with "pnpm add ${packageName}". (${asErrorMessage(error)})`,
      error,
    );
  }

  const selected = options.select(module);
  if (selected === undefined) {
    throw new UnsupportedFeatureError(
      `${requirement(feature, packageName, condition)} The installed package does not export ${options.expectedExports}.`,
    );
  }

  return selected;
}
