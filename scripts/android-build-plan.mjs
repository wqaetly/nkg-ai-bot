import { join } from "node:path";

export const DEFAULT_RELEASE_MAX_APK_MIB = 40;

export function parseAndroidBuildOptions(args) {
  const debug = args.includes("--debug");
  const explicitRelease = args.includes("--release");
  if (debug && explicitRelease) {
    throw new Error("--debug and --release cannot be used together");
  }

  const profile = debug ? "debug" : "release";
  const buildAab = args.includes("--aab");
  const buildApk = args.includes("--apk") || !buildAab;
  const configuredLimit = optionValue(args, "--max-apk-mib");
  const maxApkMiB = configuredLimit === undefined
    ? (profile === "release" ? DEFAULT_RELEASE_MAX_APK_MIB : undefined)
    : parsePositiveNumber(configuredLimit, "--max-apk-mib");

  return { profile, buildApk, buildAab, maxApkMiB };
}

export function createAndroidArtifactPlans(root, flavor, profile, buildApk, buildAab) {
  const plans = [];
  if (buildApk) {
    const directory = join(root, "app", "build", "outputs", "apk", flavor, profile);
    const baseName = `app-${flavor}-${profile}`;
    plans.push({
      kind: "apk",
      candidates: profile === "release"
        ? [join(directory, `${baseName}.apk`), join(directory, `${baseName}-unsigned.apk`)]
        : [join(directory, `${baseName}.apk`)],
    });
  }
  if (buildAab) {
    const variant = `${flavor}${profile[0].toUpperCase()}${profile.slice(1)}`;
    const directory = join(root, "app", "build", "outputs", "bundle", variant);
    const baseName = `app-${flavor}-${profile}`;
    plans.push({
      kind: "aab",
      candidates: [join(directory, `${baseName}.aab`), join(directory, `${baseName}-unsigned.aab`)],
    });
  }
  return plans;
}

export function selectExistingArtifact(plan, exists) {
  return plan.candidates.find((candidate) => exists(candidate));
}

export function assertApkSize(bytes, maxMiB) {
  const actualMiB = bytes / (1024 * 1024);
  if (actualMiB > maxMiB) {
    throw new Error(
      `Release APK is ${actualMiB.toFixed(2)} MiB, exceeding the ${maxMiB.toFixed(2)} MiB budget`,
    );
  }
  return actualMiB;
}

function optionValue(values, option) {
  const equal = values.find((value) => value.startsWith(`${option}=`));
  if (equal) return equal.slice(option.length + 1);
  const index = values.indexOf(option);
  if (index < 0) return undefined;
  const value = values[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parsePositiveNumber(value, option) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive number`);
  }
  return parsed;
}
