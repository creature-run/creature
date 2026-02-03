import { execSync } from "node:child_process";

export type BuildVariant = "prod" | "dev";

export interface BuildIdentity {
  variant: BuildVariant;
  branch: string | null;
  appName: string;
  appId: string;
  bundleId: string;
  packagerName: string;
  executableName: string;
  squirrelName: string;
  linuxPackageName: string;
  linuxBin: string;
  updaterCacheDirName: string;
}

const PRODUCTION_BRANCH = "prod";

const normalizeBranch = (branch: string): string => {
  return branch
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "")
    .trim();
};

const getBranchFromEnv = (): string | null => {
  const candidates = [
    process.env.CREATURE_BUILD_BRANCH,
    process.env.GITHUB_REF_NAME,
    process.env.BRANCH_NAME,
    process.env.CI_COMMIT_REF_NAME,
  ].filter(Boolean) as string[];

  for (const value of candidates) {
    const normalized = normalizeBranch(value);
    if (normalized) {
      return normalized;
    }
  }

  return null;
};

const getBranchFromGit = (): string | null => {
  try {
    const output = execSync("git rev-parse --abbrev-ref HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();

    if (!output || output === "HEAD") {
      return null;
    }

    return normalizeBranch(output);
  } catch {
    return null;
  }
};

const resolveVariant = (): { variant: BuildVariant; branch: string | null } => {
  const override = process.env.CREATURE_BUILD_VARIANT?.toLowerCase();
  if (override === "prod" || override === "dev") {
    return { variant: override, branch: getBranchFromEnv() ?? getBranchFromGit() };
  }

  const branch = getBranchFromEnv() ?? getBranchFromGit();
  if (branch && branch.toLowerCase() === PRODUCTION_BRANCH) {
    return { variant: "prod", branch };
  }

  return { variant: "dev", branch };
};

export const getBuildIdentity = (): BuildIdentity => {
  const { variant, branch } = resolveVariant();

  if (variant === "prod") {
    return {
      variant,
      branch,
      appName: "Creature",
      appId: "run.creature.desktop",
      bundleId: "run.creature.desktop",
      packagerName: "Creature",
      executableName: "Creature",
      squirrelName: "creature",
      linuxPackageName: "creature",
      linuxBin: "creature",
      updaterCacheDirName: "Creature",
    };
  }

  return {
    variant,
    branch,
    appName: "Creature Dev",
    appId: "run.creature.desktop.dev",
    bundleId: "run.creature.desktop.dev",
    packagerName: "Creature Dev",
    executableName: "Creature Dev",
    squirrelName: "creature-dev",
    linuxPackageName: "creature-dev",
    linuxBin: "creature-dev",
    updaterCacheDirName: "CreatureDev",
  };
};
