import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type TrevorPathEnv = Readonly<Record<string, string | undefined>>;

export const TREVOR_HOME_DIRNAME = ".trevorV2";

export function resolveTrevorHome(
  env: TrevorPathEnv = process.env,
  home: string = homedir(),
): string {
  return resolve(env.TREVOR_HOME ?? join(home, TREVOR_HOME_DIRNAME));
}

export const TREVOR_HOME = resolveTrevorHome();
