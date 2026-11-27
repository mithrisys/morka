import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { signAsync } from "@electron/osx-sign";
import { notarize } from "@electron/notarize";

const run = promisify(execFile);

export function macSigningConfig(env) {
  const { MORKA_MAC_CERTIFICATE: certificate, MORKA_MAC_CERTIFICATE_PASSWORD: password,
    MORKA_MAC_NOTARY_KEY: notaryKey, MORKA_MAC_NOTARY_KEY_ID: appleApiKeyId,
    MORKA_MAC_NOTARY_ISSUER: appleApiIssuer, MORKA_MAC_BUILD_NUMBER: buildNumber } = env;
  const credentials = [certificate, password, notaryKey, appleApiKeyId, appleApiIssuer];
  if (credentials.every(value => !value)) return;
  if (credentials.some(value => !value) || !/^[1-9]\d*$/.test(buildNumber ?? "")) {
    throw new Error("Configure all macOS signing and notarization credentials and a numeric MORKA_MAC_BUILD_NUMBER.");
  }
  return { certificate, password, notaryKey, appleApiKeyId, appleApiIssuer, buildNumber };
}

async function security(args) {
  try { await run("/usr/bin/security", args); }
  catch { throw new Error(`The temporary signing keychain could not complete ${args[0]}.`); }
}

export async function signAndNotarizeMacUpdate(bundle, config) {
  const directory = await mkdtemp(join(tmpdir(), "morka-mac-signing-"));
  const keychain = join(directory, "signing.keychain-db");
  const certificate = join(directory, "certificate.p12");
  const appleApiKey = join(directory, "AuthKey.p8");
  const keychainPassword = randomBytes(24).toString("hex");
  try {
    await Promise.all([
      writeFile(certificate, Buffer.from(config.certificate, "base64"), { mode: 0o600 }),
      writeFile(appleApiKey, config.notaryKey, { mode: 0o600 }),
    ]);
    await security(["create-keychain", "-p", keychainPassword, keychain]);
    await security(["unlock-keychain", "-p", keychainPassword, keychain]);
    await security(["import", certificate, "-k", keychain, "-P", config.password, "-T", "/usr/bin/codesign"]);
    await security(["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", keychainPassword, keychain]);
    const node = join(bundle, "Contents", "Resources", "app", "dist", "toolchain", "bin", "node");
    await signAsync({ app: bundle, platform: "darwin", keychain, preAutoEntitlements: false,
      optionsForFile: path => path === node ? { entitlements: ["com.apple.security.cs.allow-jit", "com.apple.security.cs.disable-library-validation"] } : {} });
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R",
      "anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists", bundle]);
    await notarize({ tool: "notarytool", appPath: bundle, appleApiKey, appleApiKeyId: config.appleApiKeyId,
      appleApiIssuer: config.appleApiIssuer });
    await run("/usr/bin/xcrun", ["stapler", "validate", bundle]);
  } finally {
    await run("/usr/bin/security", ["delete-keychain", keychain]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
