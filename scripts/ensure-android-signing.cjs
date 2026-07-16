const { existsSync, mkdirSync, writeFileSync } = require("fs");
const { homedir } = require("os");
const { join, resolve } = require("path");
const { randomBytes } = require("crypto");
const { spawnSync } = require("child_process");

const signingRoot = resolve(process.env.HPP_ANDROID_SIGNING_DIR || join(homedir(), ".hpp", "android-signing"));
const keyStorePath = join(signingRoot, "hpp-release.jks");
const propertiesPath = join(signingRoot, "release.properties");
const keyAlias = "hpp-release";

const hasKeyStore = existsSync(keyStorePath);
const hasProperties = existsSync(propertiesPath);
if (hasKeyStore !== hasProperties) {
  throw new Error(`Incomplete Android signing configuration in ${signingRoot}. Restore both signing files from backup.`);
}

if (hasKeyStore) {
  console.log(`Using existing Android release signing key in ${signingRoot}`);
  process.exit(0);
}

const javaHome = process.env.JAVA_HOME || "C:\\Program Files\\Android\\Android Studio\\jbr";
const keytool = join(javaHome, "bin", process.platform === "win32" ? "keytool.exe" : "keytool");
if (!existsSync(keytool)) {
  throw new Error(`keytool was not found at ${keytool}. Set JAVA_HOME to a JDK before building.`);
}

mkdirSync(signingRoot, { recursive: true });
const password = randomBytes(36).toString("base64url");
const result = spawnSync(keytool, [
  "-genkeypair",
  "-keystore", keyStorePath,
  "-storepass", password,
  "-keypass", password,
  "-alias", keyAlias,
  "-keyalg", "RSA",
  "-keysize", "4096",
  "-validity", "36500",
  "-dname", "CN=Hpp, OU=Release, O=Hpp, L=Unknown, ST=Unknown, C=CN",
], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });

if (result.status !== 0) {
  throw new Error(`Unable to generate the Android signing key: ${result.stderr || `keytool exited with ${result.status}`}`);
}

const storeFile = keyStorePath.replace(/\\/g, "/");
writeFileSync(propertiesPath, [
  `storeFile=${storeFile}`,
  `storePassword=${password}`,
  `keyAlias=${keyAlias}`,
  `keyPassword=${password}`,
  "",
].join("\n"), { encoding: "utf8", mode: 0o600 });

console.log(`Created Android release signing material in ${signingRoot}`);
console.log("Back up this directory securely. Future APK updates must use the same signing key.");
