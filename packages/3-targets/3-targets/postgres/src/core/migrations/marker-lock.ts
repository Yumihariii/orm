import type { Contract } from '@internal/contract/types';
import { UNBOUND_NAMESPACE_ID } from '@internal/framework-components/ir';

const MARKER_LOCK_DOMAIN = 'prisma_8.contract.marker';

/** Takes the transaction-scoped advisory lock named by {@link markerLockKey}. */
export const MARKER_LOCK_SQL = 'select pg_advisory_xact_lock(hashtext($1))';

/**
 * The key of the advisory lock that the migration runner and `db sign` hold while they read and write the marker of `space`, so neither writes a marker the other has just changed.
 */
export function markerLockKey(contract: Contract, space: string, schemaName?: string): string {
  const schema =
    schemaName ??
    Object.keys(contract.storage.namespaces).find((id) => id !== UNBOUND_NAMESPACE_ID) ??
    UNBOUND_NAMESPACE_ID;
  return `${MARKER_LOCK_DOMAIN}:${schema}:${space}`;
}
