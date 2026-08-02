import * as path from "node:path";

import ts from "typescript";

export interface ReadmeSnippet {
  lang: string;
  /** 1-based line number of the opening ``` fence in the markdown file. */
  fenceLine: number;
  code: string;
  marker: "skip" | "continue" | null;
}

export interface CompileUnit {
  name: string;
  fenceLine: number;
  code: string;
}

export interface SnippetDiagnostics {
  unit: CompileUnit;
  diagnostics: readonly ts.Diagnostic[];
}

const MARKER_PATTERN = /<!--\s*readme-test:\s*(skip|continue)\s*-->/;
const FENCE_OPEN_PATTERN = /^```([\w-]*)\s*$/;
const FENCE_CLOSE_PATTERN = /^```\s*$/;
const TS_LANG_PATTERN = /^(ts|typescript)$/;

/**
 * Maps every public `@thenvoi/sdk` specifier to its source entry point,
 * mirroring `package.json#exports` and the `tsup.config.ts` entry map.
 * A guard test asserts this stays in sync with `package.json#exports`.
 */
export const SDK_SUBPATH_ENTRIES: Record<string, string> = {
  "@thenvoi/sdk": "src/index.ts",
  "@thenvoi/sdk/adapters": "src/adapters/index.ts",
  "@thenvoi/sdk/config": "src/config/index.ts",
  "@thenvoi/sdk/converters": "src/converters/index.ts",
  "@thenvoi/sdk/core": "src/core/index.ts",
  "@thenvoi/sdk/linear": "src/linear/index.ts",
  "@thenvoi/sdk/rest": "src/rest/index.ts",
  "@thenvoi/sdk/runtime": "src/runtime/index.ts",
  "@thenvoi/sdk/testing": "src/testing/index.ts",
  "@thenvoi/sdk/mcp": "src/mcp/index.ts",
  "@thenvoi/sdk/mcp/claude": "src/mcp/sdk.ts",
};

/**
 * Third-party modules used by README snippets that are neither installed
 * nor declared in `src/optional-deps.d.ts`. Declared as ambient `any` so
 * snippets compile; SDK-side API usage is still strictly checked.
 */
export const EXTRA_AMBIENT_MODULES: string[] = [
  "@langchain/langgraph",
  "@langchain/core",
];

export function extractSnippets(markdown: string): ReadmeSnippet[] {
  const lines = markdown.split(/\r?\n/);
  const snippets: ReadmeSnippet[] = [];
  let index = 0;
  while (index < lines.length) {
    const open = FENCE_OPEN_PATTERN.exec(lines[index]);
    if (!open) {
      index += 1;
      continue;
    }
    const fenceLine = index + 1;
    const body: string[] = [];
    index += 1;
    while (index < lines.length && !FENCE_CLOSE_PATTERN.test(lines[index])) {
      body.push(lines[index]);
      index += 1;
    }
    index += 1;

    let marker: ReadmeSnippet["marker"] = null;
    for (let above = fenceLine - 2; above >= 0; above -= 1) {
      const line = lines[above].trim();
      if (line === "") {
        continue;
      }
      const matched = MARKER_PATTERN.exec(line);
      marker = matched ? (matched[1] as "skip" | "continue") : null;
      break;
    }

    snippets.push({ lang: open[1] ?? "", fenceLine, code: body.join("\n"), marker });
  }
  return snippets;
}

/** TypeScript snippets to compile, with `continue` blocks merged into their predecessor. */
export function tsCompileUnits(snippets: ReadmeSnippet[]): CompileUnit[] {
  const units: CompileUnit[] = [];
  for (const snippet of snippets) {
    if (!TS_LANG_PATTERN.test(snippet.lang) || snippet.marker === "skip") {
      continue;
    }
    if (snippet.marker === "continue" && units.length > 0) {
      const previous = units[units.length - 1];
      previous.code += `\n${snippet.code}`;
      continue;
    }
    units.push({
      name: `readme-L${snippet.fenceLine}`,
      fenceLine: snippet.fenceLine,
      code: snippet.code,
    });
  }
  return units;
}

export function compileUnits(units: CompileUnit[], packageRoot: string): SnippetDiagnostics[] {
  const configPath = path.join(packageRoot, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, packageRoot);

  const paths: Record<string, string[]> = {};
  for (const [specifier, entry] of Object.entries(SDK_SUBPATH_ENTRIES)) {
    paths[specifier] = [entry];
  }

  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    // Snippets are user code: they get Node types but not vitest globals.
    types: ["node"],
    baseUrl: packageRoot,
    paths,
  };

  const virtualDir = path.join(packageRoot, "tests", ".readme-virtual");
  const virtualFiles = new Map<string, string>();
  for (const unit of units) {
    // `export {}` forces module scope: top-level await works and consts
    // do not collide across snippets.
    virtualFiles.set(path.join(virtualDir, `${unit.name}.ts`), `${unit.code}\nexport {};\n`);
  }
  virtualFiles.set(
    path.join(virtualDir, "readme-extra-ambient.d.ts"),
    `${EXTRA_AMBIENT_MODULES.map((name) => `declare module "${name}";`).join("\n")}\n`,
  );

  const host = ts.createCompilerHost(options, true);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) =>
    virtualFiles.has(path.normalize(fileName)) || baseFileExists(fileName);
  host.readFile = (fileName) =>
    virtualFiles.get(path.normalize(fileName)) ?? baseReadFile(fileName);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    const contents = virtualFiles.get(path.normalize(fileName));
    if (contents !== undefined) {
      return ts.createSourceFile(fileName, contents, languageVersionOrOptions, true);
    }
    return baseGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
  };

  const rootNames = [
    ...virtualFiles.keys(),
    // Ambient declarations that let optional framework imports compile.
    path.join(packageRoot, "src", "optional-deps.d.ts"),
  ];
  const program = ts.createProgram({ rootNames, options, host });
  const allDiagnostics = ts.getPreEmitDiagnostics(program);

  return units.map((unit) => {
    const virtualPath = path.join(virtualDir, `${unit.name}.ts`);
    return {
      unit,
      diagnostics: allDiagnostics.filter(
        (diagnostic) =>
          diagnostic.file && path.normalize(diagnostic.file.fileName) === virtualPath,
      ),
    };
  });
}

/** Formats diagnostics with line numbers mapped back into README.md. */
export function formatSnippetDiagnostics(result: SnippetDiagnostics): string {
  return result.diagnostics
    .map((diagnostic) => {
      let location = "";
      if (diagnostic.file && diagnostic.start !== undefined) {
        const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        location = `README.md:${result.unit.fenceLine + line + 1} `;
      }
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      return `${location}TS${diagnostic.code}: ${message}`;
    })
    .join("\n");
}
