const stableSemanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseCreated(name, value) {
  if (value === "true") return true;
  if (value === "false" || value === "" || value === undefined) return false;
  throw new Error(`${name} must be "true", "false", or empty`);
}

function validatePackage(label, createdValue, version) {
  const created = parseCreated(`${label}_RELEASE_CREATED`, createdValue);
  if (created && !stableSemanticVersion.test(version ?? "")) {
    throw new Error(`${label}_RELEASE_VERSION must be a stable semantic version when a release is created`);
  }
  if (!created && (version ?? "") !== "") {
    throw new Error(`${label}_RELEASE_VERSION must be empty when no release is created`);
  }
}

try {
  validatePackage("SDK", process.env.SDK_RELEASE_CREATED, process.env.SDK_RELEASE_VERSION);
  validatePackage("OPENCLAW", process.env.OPENCLAW_RELEASE_CREATED, process.env.OPENCLAW_RELEASE_VERSION);
  console.log("Independent package release outputs verified.");
} catch (error) {
  console.error(`Release outputs rejected: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
