import { existsSync, readFileSync } from "node:fs";

/** Fill unset variables from .env.local and .env. Never overrides the process, never prints values. */
export function loadLocalEnv(): void {
  for (const file of [".env", ".env.local"]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

export function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

export function flag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0) return argv[index + 1];
  return undefined;
}

export function baseUrl(): string {
  const raw = process.env.COUNCIL_BASE_URL ?? "";
  const base = raw.replace(/\/$/, "");
  if (!base || !/^https?:\/\//.test(base)) {
    fail("Set COUNCIL_BASE_URL to the site origin, for example https://your-site.netlify.app");
  }
  return base;
}
