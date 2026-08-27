import type { User } from './db/schema.js';

/** The subset of a user needed for access decisions. */
export type Actor = Pick<User, 'id' | 'role'>;

export const isAdmin = (a: Actor): boolean => a.role === 'admin';
/** operator/admin may create and mutate; viewer is read-only and cannot open sessions. */
export const canWrite = (a: Actor): boolean => a.role === 'admin' || a.role === 'operator';

export type ConnRelation = 'admin' | 'owner' | 'shared' | 'none';

export interface ConnAccess {
  canView: boolean;
  canOpen: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canShare: boolean;
  relation: ConnRelation;
}

const NONE: ConnAccess = {
  canView: false,
  canOpen: false,
  canEdit: false,
  canDelete: false,
  canShare: false,
  relation: 'none',
};

/**
 * What `actor` may do with a connection owned by `ownerId`, given the actor's
 * share row for it (if any). Admins get everything; owners get everything a
 * writer can do; shared users can open, and edit only when the share allows it;
 * viewers can only ever view.
 */
export function connAccess(actor: Actor, ownerId: string, share: { canEdit: boolean } | null | undefined): ConnAccess {
  if (actor.role === 'admin') {
    return { canView: true, canOpen: true, canEdit: true, canDelete: true, canShare: true, relation: 'admin' };
  }
  const writer = canWrite(actor);
  if (ownerId === actor.id) {
    return {
      canView: true,
      canOpen: writer,
      canEdit: writer,
      canDelete: writer,
      canShare: writer,
      relation: 'owner',
    };
  }
  if (share) {
    return {
      canView: true,
      canOpen: writer,
      canEdit: writer && share.canEdit,
      canDelete: false,
      canShare: false,
      relation: 'shared',
    };
  }
  return NONE;
}
