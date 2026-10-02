import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'pathe';
import { afterAll, describe, expect, it } from 'vitest';
import {
  appScript,
  copyFixture,
  expectedTree,
  extensionScript,
  type Run,
  readTree,
  removeWorkDirs,
  runScript,
  upgrade,
} from './test-helpers';

afterAll(removeWorkDirs);

describe('a Postgres project with an extension space and three snapshots', () => {
  const run = upgrade('postgres-extension-space');
  const tree = readTree(run.root);
  const expected = expectedTree('postgres-extension-space', 'after');

  it('exits 0 without output', () => {
    expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({
      status: 0,
      stdout: '',
      stderr: '',
    });
  });

  it('rewrites the emitted contract and its declarations in the emitter form', () => {
    expect([tree['prisma/contract.json'], tree['prisma/contract.d.ts']]).toEqual([
      expected['prisma/contract.json'],
      expected['prisma/contract.d.ts'],
    ]);
  });

  it('renames every snapshot directory to its new storage hash and rewrites its files', () => {
    const snapshots = (files: Record<string, string>) =>
      Object.entries(files).filter(([path]) => path.startsWith('migrations/snapshots/'));
    expect(snapshots(tree)).toEqual(snapshots(expected));
  });

  it('rewrites from, to and migrationHash of every migration, refs and migration.ts imports', () => {
    const migrations = (files: Record<string, string>) =>
      Object.entries(files).filter(
        ([path]) => path.startsWith('migrations/') && !path.startsWith('migrations/snapshots/'),
      );
    expect(migrations(tree)).toEqual(migrations(expected));
  });

  it('leaves a contract of another family unchanged', () => {
    expect(tree['mongo/contract.json']).toBe(expected['mongo/contract.json']);
  });

  it('produces exactly the expected tree', () => {
    expect(tree).toEqual(expected);
  });
});

describe('a SQLite project with literal defaults', () => {
  it('maps every SQLite codec and rewrites JSON and integer defaults', () => {
    const run = upgrade('sqlite-defaults');
    expect({
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      tree: readTree(run.root),
    }).toEqual({
      status: 0,
      stdout: '',
      stderr: '',
      tree: expectedTree('sqlite-defaults', 'after'),
    });
  });
});

describe('a JSON column whose default document holds codecId and nativeType', () => {
  const document = { codecId: 'pg/text@1', nativeType: 'text' };
  const documentDts =
    "DefaultLiteralValue<'pg/jsonb@1', { readonly codecId: 'pg/text@1'; readonly nativeType: 'text' }>";
  const outcome = (run: Run) => {
    const tree = readTree(run.root);
    const contract = JSON.parse(tree['prisma/contract.json'] ?? '{}');
    return {
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      tree,
      document:
        contract.storage.namespaces.public.entries.table.setting.columns.payload.default.value,
      documentInDts: tree['prisma/contract.d.ts']?.includes(documentDts),
    };
  };

  it('leaves a new-format contract unchanged', () => {
    expect(outcome(upgrade('json-default-document', 'after'))).toEqual({
      status: 0,
      stdout: '',
      stderr: '',
      tree: expectedTree('json-default-document', 'after'),
      document,
      documentInDts: true,
    });
  });

  it('rewrites the column of an old-format contract and leaves the document as it was', () => {
    expect(outcome(upgrade('json-default-document'))).toEqual({
      status: 0,
      stdout: '',
      stderr: '',
      tree: expectedTree('json-default-document', 'after'),
      document,
      documentInDts: true,
    });
  });
});

describe('a SQLite project with enums typed by integer codecs', () => {
  it('rewrites their value sets, domain members and defaults as digit text', () => {
    const run = upgrade('sqlite-integer-enums');
    expect({
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      tree: readTree(run.root),
    }).toEqual({
      status: 0,
      stdout: '',
      stderr: '',
      tree: expectedTree('sqlite-integer-enums', 'after'),
    });
  });
});

describe('an extension package', () => {
  it('rewrites the contract space with the extension copy of the script', () => {
    const run = upgrade('extension-package', 'before', extensionScript);
    expect({
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      tree: readTree(run.root),
    }).toEqual({
      status: 0,
      stdout: '',
      stderr: '',
      tree: expectedTree('extension-package', 'after'),
    });
  });

  it('ships the same script to both audiences', () => {
    expect(readFileSync(extensionScript, 'utf8')).toBe(readFileSync(appScript, 'utf8'));
  });
});

describe('a project already in the new format', () => {
  for (const name of ['postgres-extension-space', 'sqlite-defaults', 'extension-package']) {
    it(`leaves ${name} unchanged and exits 0`, () => {
      const run = upgrade(name, 'after');
      expect({
        status: run.status,
        stdout: run.stdout,
        stderr: run.stderr,
        tree: readTree(run.root),
      }).toEqual({ status: 0, stdout: '', stderr: '', tree: expectedTree(name, 'after') });
    });
  }

  it('leaves a new-format contract unchanged whatever its stored hash', () => {
    const root = copyFixture('sqlite-defaults', 'after');
    const contract = JSON.parse(readFileSync(join(root, 'src/prisma/contract.json'), 'utf8'));
    const { storageHash: _storageHash, ...storage } = contract.storage;
    const placeholder = `${JSON.stringify({ ...contract, storage: { ...storage, storageHash: 'sha256:test-fixture' } }, null, 2)}\n`;
    const withoutHash = `${JSON.stringify({ ...contract, storage }, null, 2)}\n`;
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'test/placeholder-hash.contract.json'), placeholder);
    writeFileSync(join(root, 'test/no-hash.contract.json'), withoutHash);
    const before = readTree(root);
    const run = runScript(root);
    expect({
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      tree: readTree(root),
    }).toEqual({
      status: 0,
      stdout: '',
      stderr: '',
      tree: before,
    });
  });

  it('is unchanged by a second run', () => {
    const first = upgrade('postgres-extension-space');
    const second = runScript(first.root);
    expect({ status: second.status, stdout: second.stdout, tree: readTree(second.root) }).toEqual({
      status: 0,
      stdout: '',
      tree: expectedTree('postgres-extension-space', 'after'),
    });
  });
});
