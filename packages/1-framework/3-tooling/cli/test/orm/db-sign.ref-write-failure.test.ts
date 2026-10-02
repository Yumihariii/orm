import { chmod, mkdir } from 'node:fs/promises';
import { writeRef } from '@internal/migration-tools/refs';
import { ok } from '@internal/utils/result';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupProjectDirs,
  envelopeOf,
  HASH_A,
  HASH_EXT,
  harness,
  mocks,
  ormConfig,
  projectDir,
  refHashOf,
  refsDirOf,
  resetMocks,
  signedSpace,
} from './db-sign-fixtures';

beforeEach(resetMocks);
afterEach(cleanupProjectDirs);

/** Makes the app space's refs directory read-only for the duration of `run`. */
async function withReadOnlyAppRefs<T>(dir: string, run: () => Promise<T>): Promise<T> {
  await mkdir(refsDirOf(dir), { recursive: true });
  await chmod(refsDirOf(dir), 0o555);
  try {
    return await run();
  } finally {
    await chmod(refsDirOf(dir), 0o755);
  }
}

function settledError(run: { readonly json: readonly { readonly kind: string }[] }) {
  const terminal = run.json.at(-1);
  if (terminal === undefined || terminal.kind !== 'result') {
    throw new Error('the run did not settle');
  }
  const envelope = Reflect.get(terminal, 'envelope');
  return Reflect.get(Object(envelope), 'error');
}

describe('db sign when a ref cannot be written after the markers are written', () => {
  beforeEach(() => {
    mocks.dbSign.mockResolvedValue(
      ok({ spaces: [signedSpace('app', HASH_A), signedSpace('pgvector', HASH_EXT)] }),
    );
  });

  it('says the database was signed, names the ref it could not write, and writes the other refs', async () => {
    const dir = await projectDir();

    const run = await withReadOnlyAppRefs(dir, () =>
      harness(ormConfig()).run(['db', 'sign', '--json'], { cwd: dir }),
    );

    expect(run.exitCode).toBe(2);
    expect(envelopeOf(run)).toMatchObject({
      ok: false,
      error: { code: 'MIGRATION.SIGN_REFS_NOT_WRITTEN' },
    });
    expect(settledError(run)).toMatchObject({
      summary: 'Database signed, but 1 ref was not written',
      why: expect.stringMatching(
        /^The database was signed: the markers of spaces "app", "pgvector" were written\. These refs were not written: ref "db" of space "app" \(.*EACCES.*\)\.$/,
      ),
      nextActions: [
        {
          kind: 'run-command',
          label: 'Sign again to write the refs that were not written',
          command: 'prisma-test db sign',
        },
      ],
      meta: {
        signedSpaces: ['app', 'pgvector'],
        unwrittenRefs: [{ space: 'app', name: 'db', hash: HASH_A }],
        advancedRefs: [{ space: 'pgvector', name: 'db', hash: HASH_EXT }],
      },
    });
    expect(await refHashOf(dir, 'db', 'pgvector')).toBe(HASH_EXT);
    expect(await refHashOf(dir, 'db')).toBeUndefined();
  });

  it('repeats the contract and ref arguments in the command that finishes the job', async () => {
    const dir = await projectDir();
    await writeRef(refsDirOf(dir), 'staging', { hash: HASH_A, invariants: [] });

    const run = await withReadOnlyAppRefs(dir, () =>
      harness(ormConfig()).run(
        ['db', 'sign', '--contract', 'staging', '--advance-ref', 'production', '--json'],
        { cwd: dir },
      ),
    );

    expect(run.exitCode).toBe(2);
    expect(settledError(run)).toMatchObject({
      nextActions: [
        {
          kind: 'run-command',
          command: 'prisma-test db sign --contract "staging" --advance-ref production',
        },
      ],
    });
  });
});
