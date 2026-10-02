import { spawn } from "node:child_process";

const MAX_CREDENTIAL_BYTES = 64 * 1024;
const CREDENTIAL_COMMAND_TIMEOUT_MS = 30_000;
const SAFE_KEY = /^[A-Za-z0-9._:-]{1,256}$/;

export interface OAuthCredentialStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface SystemCredentialStoreOptions {
  service: string;
  platform?: NodeJS.Platform;
}

export class OAuthCredentialStoreUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OAuthCredentialStoreUnavailableError";
  }
}

export class MemoryOAuthCredentialStore implements OAuthCredentialStore {
  private readonly values = new Map<string, string>();

  public async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  public async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  public async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export function createSystemCredentialStore(
  options: SystemCredentialStoreOptions,
): OAuthCredentialStore {
  assertSafeKey(options.service, "credential service");
  const platform = options.platform ?? process.platform;
  switch (platform) {
    case "darwin":
      return new MacOsCredentialStore(options.service);
    case "linux":
      return new LinuxSecretServiceStore(options.service);
    case "win32":
      return new WindowsCredentialStore(options.service);
    default:
      throw new OAuthCredentialStoreUnavailableError(
        `No system credential store is available for ${platform}`,
      );
  }
}

class MacOsCredentialStore implements OAuthCredentialStore {
  public constructor(private readonly service: string) {}

  public async get(key: string): Promise<string | undefined> {
    assertSafeKey(key, "credential key");
    const result = await runCredentialCommand(
      "/usr/bin/security",
      ["find-generic-password", "-a", key, "-s", this.service, "-w"],
    );
    if (result.code === 44) return undefined;
    requireSuccess(result, "macOS Keychain lookup");
    return result.stdout.replace(/\r?\n$/, "");
  }

  public async set(key: string, value: string): Promise<void> {
    assertCredential(key, value);
    const command = `add-generic-password -U -a "${key}" -s "${this.service}" -X ${Buffer.from(value).toString("hex")}\n`;
    const result = await runCredentialCommand("/usr/bin/security", ["-i"], command);
    requireSuccess(result, "macOS Keychain update");
  }

  public async delete(key: string): Promise<void> {
    assertSafeKey(key, "credential key");
    const result = await runCredentialCommand(
      "/usr/bin/security",
      ["delete-generic-password", "-a", key, "-s", this.service],
    );
    if (result.code === 44) return;
    requireSuccess(result, "macOS Keychain delete");
  }
}

class LinuxSecretServiceStore implements OAuthCredentialStore {
  public constructor(private readonly service: string) {}

  public async get(key: string): Promise<string | undefined> {
    assertSafeKey(key, "credential key");
    const result = await runCredentialCommand(
      "secret-tool",
      ["lookup", "service", this.service, "account", key],
    );
    if (result.code === 1) return undefined;
    requireSuccess(result, "Secret Service lookup");
    return result.stdout.replace(/\r?\n$/, "");
  }

  public async set(key: string, value: string): Promise<void> {
    assertCredential(key, value);
    const result = await runCredentialCommand(
      "secret-tool",
      [
        "store",
        `--label=${this.service} ${key}`,
        "service",
        this.service,
        "account",
        key,
      ],
      value,
    );
    requireSuccess(result, "Secret Service update");
  }

  public async delete(key: string): Promise<void> {
    assertSafeKey(key, "credential key");
    const result = await runCredentialCommand(
      "secret-tool",
      ["clear", "service", this.service, "account", key],
    );
    if (result.code === 1) return;
    requireSuccess(result, "Secret Service delete");
  }
}
const WINDOWS_PASSWORD_VAULT_SETUP =
  "$null=[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];";

class WindowsCredentialStore implements OAuthCredentialStore {
  public constructor(private readonly service: string) {}

  public async get(key: string): Promise<string | undefined> {
    assertSafeKey(key, "credential key");
    const script = `${WINDOWS_PASSWORD_VAULT_SETUP}$ErrorActionPreference='Stop';$v=New-Object Windows.Security.Credentials.PasswordVault;try{$c=$v.Retrieve('${ps(this.service)}','${ps(key)}');$c.RetrievePassword();[Console]::Out.Write($c.Password)}catch [System.Exception]{if($_.Exception.HResult -eq -2147023728){exit 3};throw}`;
    const result = await runCredentialCommand(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
    );
    if (result.code === 3) return undefined;
    requireSuccess(result, "Windows Credential Locker lookup");
    return result.stdout;
  }

  public async set(key: string, value: string): Promise<void> {
    assertCredential(key, value);
    const script = `${WINDOWS_PASSWORD_VAULT_SETUP}$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd();$v=New-Object Windows.Security.Credentials.PasswordVault;try{$o=$v.Retrieve('${ps(this.service)}','${ps(key)}');$v.Remove($o)}catch{};$c=New-Object Windows.Security.Credentials.PasswordCredential('${ps(this.service)}','${ps(key)}',$p);$v.Add($c)`;
    const result = await runCredentialCommand(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      value,
    );
    requireSuccess(result, "Windows Credential Locker update");
  }

  public async delete(key: string): Promise<void> {
    assertSafeKey(key, "credential key");
    const script = `${WINDOWS_PASSWORD_VAULT_SETUP}$ErrorActionPreference='Stop';$v=New-Object Windows.Security.Credentials.PasswordVault;try{$c=$v.Retrieve('${ps(this.service)}','${ps(key)}');$v.Remove($c)}catch [System.Exception]{if($_.Exception.HResult -eq -2147023728){exit 0};throw}`;
    const result = await runCredentialCommand(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
    );
    requireSuccess(result, "Windows Credential Locker delete");
  }
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCredentialCommand(
  executable: string,
  args: readonly string[],
  input?: string,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new OAuthCredentialStoreUnavailableError("Credential-store command timed out"));
    }, CREDENTIAL_COMMAND_TIMEOUT_MS);
    timeout.unref?.();
    child.stdin.on("error", () => undefined);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const collect = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > MAX_CREDENTIAL_BYTES) {
        child.kill();
        reject(new OAuthCredentialStoreUnavailableError("Credential-store response exceeded its limit"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new OAuthCredentialStoreUnavailableError(`Credential-store command is unavailable: ${executable}`));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(input);
  });
}

function requireSuccess(result: CommandResult, operation: string): void {
  if (result.code !== 0) {
    throw new OAuthCredentialStoreUnavailableError(
      `${operation} failed with exit code ${result.code}`,
    );
  }
}

function assertCredential(key: string, value: string): void {
  assertSafeKey(key, "credential key");
  if (value.length === 0 || Buffer.byteLength(value) > MAX_CREDENTIAL_BYTES || value.includes("\0")) {
    throw new OAuthCredentialStoreUnavailableError("Credential value is empty or too large");
  }
}

function assertSafeKey(value: string, label: string): void {
  if (!SAFE_KEY.test(value)) {
    throw new OAuthCredentialStoreUnavailableError(`${label} is invalid`);
  }
}

function ps(value: string): string {
  return value.replaceAll("'", "''");
}
