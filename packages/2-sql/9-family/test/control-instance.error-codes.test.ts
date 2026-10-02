import { APP_SPACE_ID, type SchemaDiffIssue } from '@internal/framework-components/control';
import type { SqlControlDriverInstance } from '@internal/sql-contract/types';
import { isStructuredError } from '@internal/utils/structured-error';
import { describe, expect, it } from 'vitest';
import type { SqlControlAdapter } from '../src/core/control-adapter';
import { createSqlFamilyInstance } from '../src/core/control-instance';
import { buildContract, makeStack } from './control-instance-stack.helpers';

function captureError(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('sql family instance structured error codes', () => {
  it('raises CONTRACT.INFER_UNSUPPORTED when the target descriptor has no inferPslContract', () => {
    const instance = createSqlFamilyInstance(makeStack());
    const error = captureError(() => instance.inferPslContract?.(undefined as never));
    expect(isStructuredError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'CONTRACT.INFER_UNSUPPORTED',
      meta: { targetId: 'postgres' },
    });
  });

  it('raises CONTRACT.PACK_CONTRIBUTION_INVALID when a required classifier descriptor operation is missing', () => {
    const instance = createSqlFamilyInstance(makeStack());
    const error = captureError(() => instance.classifySubjectGranularity?.({} as SchemaDiffIssue));
    expect(isStructuredError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'CONTRACT.PACK_CONTRIBUTION_INVALID',
      meta: { targetId: 'postgres', operation: 'classifySubjectGranularity' },
    });
  });

  it('raises MIGRATION.MARKER_CAS_FAILURE when the marker CAS update loses the race during signSpaces', async () => {
    const adapterStub = {
      familyId: 'sql',
      targetId: 'postgres',
      bootstrapSignMarkerQueries: () => [],
      withTransaction: (_driver: unknown, fn: () => Promise<unknown>) => fn(),
      readMarker: async () => ({
        storageHash: 'stale-hash',
        profileHash: 'stale-profile',
        contractJson: null,
        updatedAt: new Date(),
        invariants: [],
      }),
      updateMarker: async () => false,
    } as unknown as SqlControlAdapter<string>;
    const instance = createSqlFamilyInstance(makeStack({ createAdapter: () => adapterStub }));

    const driver = {} as SqlControlDriverInstance<string>;
    const error = await instance
      .signSpaces({ driver, spaces: [{ space: APP_SPACE_ID, contract: buildContract() }] })
      .then(() => {
        throw new Error('expected signSpaces() to reject');
      })
      .catch((err: unknown) => err);

    expect(isStructuredError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'MIGRATION.MARKER_CAS_FAILURE',
      message: 'CAS conflict: marker was modified by another process during sign',
    });
  });
});
