/**
 * Credential resolution for the two stages that talk to the model.
 *
 * An unset ANTHROPIC_API_KEY does not mean there are no credentials: the SDK
 * also honours ANTHROPIC_AUTH_TOKEN and the OAuth profile written by
 * `ant auth login`. So we never construct the client with an explicit key —
 * we let the SDK resolve, and only pre-check so the CLI can say something
 * useful instead of surfacing a raw 401.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function configDir() {
  if (process.env.ANTHROPIC_CONFIG_DIR) return process.env.ANTHROPIC_CONFIG_DIR;
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'Anthropic');
  return join(homedir(), '.config', 'anthropic');
}

/** True when `ant auth login` has stored at least one profile. */
function profileOnDisk() {
  try {
    return readdirSync(join(configDir(), 'credentials')).some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}

/** Cheap pre-flight. A false here means the request would certainly 401. */
export function hasCredentials() {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.ANTHROPIC_PROFILE ||
    profileOnDisk(),
  );
}

export const CREDENTIAL_HINT =
  'no Anthropic credentials found — export ANTHROPIC_API_KEY, or run `ant auth login`';

/** Zero-arg construction on purpose: the SDK owns the resolution order. */
export function makeClient() {
  return new Anthropic();
}

export function isAuthError(err) {
  return err instanceof Anthropic.AuthenticationError
    || err instanceof Anthropic.PermissionDeniedError;
}

export { Anthropic };
