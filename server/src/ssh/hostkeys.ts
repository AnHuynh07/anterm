import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { hostKeys } from '../db/schema.js';
import type { HostKeyInfo, HostKeyVerifier } from './client.js';

export type HostKeyStatus = 'known' | 'unknown' | 'changed';

export interface HostKeyPrompt {
  (info: HostKeyInfo & { status: HostKeyStatus; knownFingerprint?: string }): Promise<boolean>;
}

/**
 * Trust-on-first-use verifier.
 *  - known + matching fingerprint  -> trust silently
 *  - unknown host                  -> ask the user; store on accept
 *  - fingerprint changed           -> ask the user (loud warning); replace on accept
 */
export function makeHostKeyVerifier(
  db: Db,
  userId: string | null,
  prompt: HostKeyPrompt,
  onTrust?: (info: HostKeyInfo & { status: HostKeyStatus }) => void,
): HostKeyVerifier {
  return async (info: HostKeyInfo): Promise<boolean> => {
    const existing = await db.query.hostKeys.findFirst({ where: eq(hostKeys.hostport, info.hostport) });

    if (existing && existing.fingerprintSha256 === info.fingerprint) return true;

    const status: HostKeyStatus = existing ? 'changed' : 'unknown';
    const accepted = await prompt({ ...info, status, knownFingerprint: existing?.fingerprintSha256 });
    if (!accepted) return false;

    if (existing) {
      await db
        .update(hostKeys)
        .set({ fingerprintSha256: info.fingerprint, keyType: info.keyType, addedAt: Math.floor(Date.now() / 1000) })
        .where(eq(hostKeys.hostport, info.hostport));
    } else {
      await db.insert(hostKeys).values({
        id: randomUUID(),
        hostport: info.hostport,
        keyType: info.keyType,
        fingerprintSha256: info.fingerprint,
        addedByUserId: userId,
      });
    }
    onTrust?.({ ...info, status });
    return true;
  };
}
