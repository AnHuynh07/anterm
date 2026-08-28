import { z } from 'zod';

/**
 * WebSocket wire protocol for /ws/terminal.
 *
 *  - TEXT frames  = JSON control messages (schemas below)
 *  - BINARY frames = raw terminal bytes (stdin client->server, stdout server->client)
 */

export const clientMessage = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('open'),
    connectionId: z.string().uuid().optional(),
    adhoc: z
      .object({
        host: z.string().min(1),
        port: z.number().int().positive().max(65535).default(22),
        username: z.string().min(1),
        password: z.string().optional(),
        privateKey: z.string().optional(),
        passphrase: z.string().optional(),
      })
      .optional(),
    cols: z.number().int().positive().max(1000).default(80),
    rows: z.number().int().positive().max(1000).default(24),
  }),
  z.object({
    t: z.literal('attach'),
    token: z.string().min(8).max(128),
    cols: z.number().int().positive().max(1000).default(80),
    rows: z.number().int().positive().max(1000).default(24),
  }),
  z.object({ t: z.literal('resize'), cols: z.number().int().positive().max(1000), rows: z.number().int().positive().max(1000) }),
  z.object({ t: z.literal('hostkey'), accept: z.boolean() }),
  z.object({ t: z.literal('share'), enabled: z.boolean() }),
  z.object({ t: z.literal('ping') }),
]);

export type ClientMessage = z.infer<typeof clientMessage>;

export type ServerMessage =
  | { t: 'status'; state: 'connecting' | 'ready' | 'closed'; detail?: string }
  | { t: 'attached'; token: string; resumed?: boolean; readOnly?: boolean; owner?: string }
  | { t: 'presence'; viewers: string[] }
  | {
      t: 'hostkey-prompt';
      hostport: string;
      status: 'unknown' | 'changed';
      keyType: string;
      fingerprint: string;
      knownFingerprint?: string;
    }
  | { t: 'error'; message: string }
  | { t: 'pong' };

export function encodeServer(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
