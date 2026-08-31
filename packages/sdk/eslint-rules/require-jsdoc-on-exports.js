/**
 * Requires a JSDoc block on exported declarations that consumers see.
 *
 * ESLint ships no JSDoc rule and the project has no JSDoc plugin, so this is a local rule
 * rather than a new dependency. Configure which declarations it applies to per file group:
 *
 *   targets     - any of "class", "interface", "type"
 *   namePattern - optional regex source; only declarations whose name matches are checked
 */

const TARGET_NODE_TYPES = {
  class: "ClassDeclaration",
  interface: "TSInterfaceDeclaration",
  type: "TSTypeAliasDeclaration",
};

const KIND_LABELS = {
  ClassDeclaration: "class",
  TSInterfaceDeclaration: "interface",
  TSTypeAliasDeclaration: "type",
};

/** @type {import("eslint").Rule.RuleModule} */
export const requireJsdocOnExports = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Require a JSDoc block on exported declarations that are part of the public surface.",
    },
    schema: [
      {
        type: "object",
        properties: {
          targets: {
            type: "array",
            items: { enum: Object.keys(TARGET_NODE_TYPES) },
            minItems: 1,
          },
          namePattern: { type: "string" },
        },
        required: ["targets"],
        additionalProperties: false,
      },
    ],
    messages: {
      missing:
        "Exported {{kind}} `{{name}}` needs a JSDoc block saying what it is for. Public exports are documented so consumers do not have to read the implementation.",
    },
  },

  create(context) {
    const options = context.options[0];
    const wantedNodeTypes = new Set(options.targets.map((target) => TARGET_NODE_TYPES[target]));
    const namePattern = options.namePattern ? new RegExp(options.namePattern) : null;
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    function hasJsdoc(node) {
      const comments = sourceCode.getCommentsBefore(node);
      return comments.some((comment) => comment.type === "Block" && comment.value.startsWith("*"));
    }

    return {
      ExportNamedDeclaration(node) {
        const declaration = node.declaration;
        if (!declaration || !wantedNodeTypes.has(declaration.type) || !declaration.id) {
          return;
        }

        const name = declaration.id.name;
        if (namePattern && !namePattern.test(name)) {
          return;
        }

        // The comment sits before `export`, so check the export statement, not the
        // declaration nested inside it.
        if (hasJsdoc(node) || hasJsdoc(declaration)) {
          return;
        }

        context.report({
          node: declaration.id,
          messageId: "missing",
          data: { kind: KIND_LABELS[declaration.type], name },
        });
      },
    };
  },
};
