import { type Contract, coreHash, profileHash } from '@internal/contract/types';
import { UNBOUND_NAMESPACE_ID } from '@internal/framework-components/ir';
import { SqlStorage } from '@internal/sql-contract/types';
import { applicationDomainOf } from '@repo/test-utils';
import { describe, expect, it } from 'vitest';
import { markerLockKey } from '../../src/core/migrations/marker-lock';
import { PostgresSchema, PostgresUnboundSchema } from '../../src/core/postgres-schema';

function contractWithNamespaces(namespaceIds: readonly string[]): Contract<SqlStorage> {
  return {
    target: 'postgres',
    targetFamily: 'sql',
    profileHash: profileHash('test'),
    storage: new SqlStorage({
      storageHash: coreHash('contract'),
      namespaces: {
        [UNBOUND_NAMESPACE_ID]: PostgresUnboundSchema.instance,
        ...Object.fromEntries(
          namespaceIds.map((id) => [id, new PostgresSchema({ id, entries: { table: {} } })]),
        ),
      },
    }),
    roots: {},
    domain: applicationDomainOf({ models: {} }),
    capabilities: {},
    extensions: {},
    meta: {},
  };
}

describe('markerLockKey', () => {
  it('names the contract’s first named namespace and the space', () => {
    expect(markerLockKey(contractWithNamespaces(['public', 'auth']), 'app')).toBe(
      'prisma_8.contract.marker:public:app',
    );
  });

  it('names the unbound namespace when the contract has no named one', () => {
    expect(markerLockKey(contractWithNamespaces([]), 'pgvector')).toBe(
      `prisma_8.contract.marker:${UNBOUND_NAMESPACE_ID}:pgvector`,
    );
  });

  it('names the schema the caller gives instead of the contract’s namespace', () => {
    expect(markerLockKey(contractWithNamespaces(['public']), 'app', 'tenant_1')).toBe(
      'prisma_8.contract.marker:tenant_1:app',
    );
  });
});
