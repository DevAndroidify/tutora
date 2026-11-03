import { AppError } from '../../../platform/errors/app-error';
import type { AuthUser } from '../../../platform/http/request-context';

export interface OwnershipOptions {
  /** Let signed-in staff (admin app) act on anyone's record. Defaults to false. */
  allowStaff?: boolean;
  /** Error code to return. Defaults to NOT_OWNER. */
  code?: string;
}

export function isOwner(user: AuthUser, ownerId: string | null | undefined): boolean {
  return ownerId !== null && ownerId !== undefined && user.id === ownerId;
}

/**
 * Throws 403 unless the caller owns the record (or is allowed staff).
 * Call on every read and write of user-owned data.
 */
export function assertOwnership(
  user: AuthUser,
  ownerId: string | null | undefined,
  options: OwnershipOptions = {},
): void {
  if (isOwner(user, ownerId)) return;
  if (options.allowStaff && user.accountType === 'STAFF' && user.app === 'admin') return;
  throw AppError.forbidden(options.code ?? 'NOT_OWNER', 'You do not have access to this record.');
}
