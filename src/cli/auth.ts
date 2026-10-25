// `auth`: checks a Personal API key with Garmin, then saves it to the key file (0600).
// `auth --check`: checks the configured key without prompting, so scripts and agents can run it.

import { constants } from "node:fs";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { apiKeySource, type Config, loadApiKey } from "../config.ts";
import { GarminApiError, TokenManager } from "../garmin/index.ts";

export const KEY_PAGE = "https://connect.garmin.com/app/settings/personalApiToken";

export interface AuthIo {
  /** Reads the key: a hidden prompt on a terminal, otherwise the first line of stdin. */
  readKey: () => Promise<string>;
  write: (text: string) => void;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export class AuthCancelled extends Error {}

export async function authCommand(config: Config, options: { check: boolean }, io: AuthIo): Promise<number> {
  const source = apiKeySource(config, io.env);

  if (options.check) {
    if (source.kind === "missing") {
      io.write(
        `No API key configured. Run the "auth" command to add one (key file: ${config.apiKeyFile}).\n`,
      );
      return 1;
    }
    const where = source.kind === "env" ? "GARMIN_PERSONAL_API_KEY" : source.path;
    io.write(`Checking the key from ${where} with Garmin...\n`);
    return verify(config, () => loadApiKey(config, io.env), io);
  }

  // Fail before the user pastes a key we can't store (e.g. Docker mounts the key file read-only).
  const unwritable = await whyUnwritable(config.apiKeyFile);
  if (unwritable) {
    io.write(
      `Can't save the key to ${config.apiKeyFile}: ${unwritable}.\n` +
        "In Docker, create the key file on the host (README, step 1) and check it with `auth --check`.\n",
    );
    return 1;
  }

  io.write(`Create a key at ${KEY_PAGE} (Garmin shows it only once), then paste it here.\n`);
  const key = (await io.readKey()).trim();
  if (!key) {
    io.write("No key entered; nothing saved.\n");
    return 1;
  }
  io.write("Checking the key with Garmin...\n");
  const code = await verify(config, async () => key, io);
  if (code !== 0) {
    io.write("Nothing saved.\n");
    return code;
  }

  await saveKey(config.apiKeyFile, key);
  io.write(`Saved to ${config.apiKeyFile} (readable only by you).\n`);
  if (source.kind === "env") {
    io.write(
      "Note: GARMIN_PERSONAL_API_KEY is set and takes precedence over the file. Unset it to use the saved key.\n",
    );
  }
  if (!config.apiKeyExpires) {
    io.write(
      "Tip: Garmin doesn't report when a key expires. Set GARMIN_API_KEY_EXPIRES (e.g. 2027-10-24) " +
        "in your client config and garmin_status reminds you in time.\n",
    );
  }
  return 0;
}

/** Exchanges the key for a token, without the token cache, so a revoked key can't pass on a cached token. */
async function verify(config: Config, loadKey: () => Promise<string>, io: AuthIo): Promise<number> {
  const tokens = new TokenManager({
    baseUrl: config.baseUrl,
    loadKey,
    ...(io.fetch ? { fetch: io.fetch } : {}),
  });
  try {
    await tokens.getToken();
  } catch (error) {
    if (!(error instanceof GarminApiError)) throw error;
    if (error.kind === "key_rejected" || error.kind === "missing_key") {
      io.write(`${error.message}\n`);
    } else {
      io.write(`Couldn't check the key: ${error.message}\n`);
    }
    return 1;
  }
  io.write("Garmin accepted the key.\n");
  return 0;
}

/** Checks the file, or the nearest directory that exists, since saving creates the missing ones. */
async function whyUnwritable(file: string): Promise<string | undefined> {
  let target = file;
  while (!(await exists(target)) && dirname(target) !== target) target = dirname(target);
  try {
    await access(target, constants.W_OK);
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EROFS"
      ? `${target} is read-only`
      : code === "EACCES"
        ? `no write access to ${target}`
        : (error as Error).message;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function saveKey(file: string, key: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, key, { mode: 0o600 });
  await chmod(file, 0o600); // writeFile's mode only applies when creating the file
}

/** Hidden prompt on a terminal; otherwise reads the first line, so piping or `docker run -i` works. */
export async function readKeyFromStdin(
  stdin: NodeJS.ReadStream = process.stdin,
  out: NodeJS.WriteStream = process.stderr,
): Promise<string> {
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin });
    try {
      for await (const line of rl) return line;
      return "";
    } finally {
      rl.close();
    }
  }

  out.write("Personal API key (input hidden): ");
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let key = "";
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n" || ch === "\u0004") {
            stdin.off("data", onData);
            resolve(key);
            return;
          }
          if (ch === "\u0003") {
            stdin.off("data", onData);
            reject(new AuthCancelled("Cancelled; nothing saved."));
            return;
          }
          if (ch === "\u007f" || ch === "\b") key = key.slice(0, -1);
          else key += ch;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    out.write("\n");
  }
}
