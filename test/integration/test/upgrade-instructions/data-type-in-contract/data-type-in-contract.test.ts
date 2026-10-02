import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'pathe';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT_PATHS = {
  app: 'upgrade-instructions/pending/data-type-in-contract/app/scripts/data-type-in-contract.ts',
  extension:
    'upgrade-instructions/pending/data-type-in-contract/extension/scripts/data-type-in-contract.ts',
} as const;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../../../..');
const fixtures = join(here, 'fixtures');
const appScript = join(repoRoot, SCRIPT_PATHS.app);
const extensionScript = join(repoRoot, SCRIPT_PATHS.extension);
const workDirs: string[] = [];

afterAll(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

function readTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(root, path)] = readFileSync(path, 'utf8');
  }
  return files;
}

interface Run {
  readonly root: string;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function copyFixture(name: string, side: 'before' | 'after'): string {
  const root = mkdtempSync(join(tmpdir(), `data-type-in-contract-${name}-`));
  workDirs.push(root);
  cpSync(join(fixtures, name, side), root, { recursive: true });
  return root;
}

function runScript(root: string, script = appScript, options: readonly string[] = []): Run {
  const result = spawnSync(process.execPath, [script, root, ...options], { encoding: 'utf8' });
  return { root, status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function upgrade(name: string, side: 'before' | 'after' = 'before', script = appScript): Run {
  return runScript(copyFixture(name, side), script);
}

function expectedTree(name: string, side: 'before' | 'after'): Record<string, string> {
  return readTree(join(fixtures, name, side));
}

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

describe('a migration.ts that writes hashes as literals', () => {
  const oldHash = '3d2c56a2944685bd21b05bc8a8d73164397df51c014201902932fbe7e80ff1b8';
  const newHash = '4a96b488a4ce92b434e5f7d6607b6435c0955f0d36b0018077045787764240e6';
  const unrelated = 'c'.repeat(64);
  const migrationTs = (hash: string) =>
    [
      'export default class M extends Migration {',
      `  readonly checksum = '${unrelated}';`,
      '  override describe() {',
      `    return { from: '${hash}', to: '${hash}' };`,
      '  }',
      '}',
      '',
    ].join('\n');

  it('replaces every mapped hash and leaves other hashes unchanged', () => {
    const root = copyFixture('extension-package', 'before');
    const path = join(root, 'migrations', '20260601T0000_install_vector_extension', 'migration.ts');
    writeFileSync(path, migrationTs(oldHash));
    const run = runScript(root, extensionScript);
    expect({ status: run.status, migrationTs: readFileSync(path, 'utf8') }).toEqual({
      status: 0,
      migrationTs: migrationTs(newHash),
    });
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

describe('a codec the script does not know', () => {
  const unchanged = (run: Run) => ({
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    tree: readTree(run.root),
  });

  it('names each file, the codec and the option, changes no file and exits 1', () => {
    const run = upgrade('unknown-codec');
    const snapshot = Object.keys(expectedTree('unknown-codec', 'before')).find(
      (path) => path.startsWith('migrations/snapshots/') && path.endsWith('/contract.json'),
    );
    expect(unchanged(run)).toEqual({
      status: 1,
      stdout: '',
      stderr: [
        `${snapshot}: unknown codec acme/shape@1; name its data type with --data-type acme/shape@1=<data type id>`,
        'prisma/contract.json: unknown codec acme/shape@1; name its data type with --data-type acme/shape@1=<data type id>',
        '',
      ].join('\n'),
      tree: expectedTree('unknown-codec', 'before'),
    });
  });

  it('upgrades when --data-type names its data type', () => {
    const run = runScript(copyFixture('unknown-codec', 'before'), appScript, [
      '--data-type',
      'acme/shape@1=acme/shape',
    ]);
    expect(unchanged(run)).toEqual({
      status: 0,
      stdout: '',
      stderr: '',
      tree: expectedTree('unknown-codec', 'after'),
    });
  });

  for (const value of ['acme/shape@1', 'acme/shape@1=', '=acme/shape', 'acme/shape@1=Acme Shape']) {
    it(`refuses the malformed value ${JSON.stringify(value)} without changing a file`, () => {
      const run = runScript(copyFixture('unknown-codec', 'before'), appScript, [
        '--data-type',
        value,
      ]);
      expect(unchanged(run)).toEqual({
        status: 1,
        stdout: '',
        stderr: `--data-type ${value}: expected <codec id>=<data type id>, for example acme/shape@1=acme/shape\n`,
        tree: expectedTree('unknown-codec', 'before'),
      });
    });
  }

  it('refuses to change the data type of a codec it already knows', () => {
    const run = runScript(copyFixture('unknown-codec', 'before'), appScript, [
      '--data-type',
      'acme/shape@1=acme/shape',
      '--data-type',
      'pg/uuid@1=pg/text',
    ]);
    expect(unchanged(run)).toEqual({
      status: 1,
      stdout: '',
      stderr: '--data-type pg/uuid@1=pg/text: the script already maps pg/uuid@1 to pg/uuid\n',
      tree: expectedTree('unknown-codec', 'before'),
    });
  });
});

describe('a snapshot directory that already holds the new hash', () => {
  it('stops when its content differs, changes no file and exits 1', () => {
    const run = upgrade('snapshot-collision');
    expect({
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      tree: readTree(run.root),
    }).toEqual({
      status: 1,
      stdout: '',
      stderr:
        'migrations/snapshots/d3a277a78b83a532f1ce006d0b7b5e059cc9d15a440922acd9df1055156afbf2: snapshot directory already exists with different content\n',
      tree: expectedTree('snapshot-collision', 'before'),
    });
  });

  it('removes the old directory when the content is the same', () => {
    const run = upgrade('snapshot-already-present');
    expect({
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      tree: readTree(run.root),
    }).toEqual({
      status: 0,
      stdout: '',
      stderr: '',
      tree: expectedTree('snapshot-already-present', 'after'),
    });
  });
});

describe('a snapshot whose stored hash does not recompute', () => {
  it('rehashes it from content, says so and rewrites everything that names it', () => {
    const run = upgrade('stale-hash');
    expect({
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      tree: readTree(run.root),
    }).toEqual({
      status: 0,
      stdout: `migrations/snapshots/${'a'.repeat(64)}/contract.json: stored hash did not recompute; rehashed from content\n`,
      stderr: '',
      tree: expectedTree('stale-hash', 'after'),
    });
  });
});

describe('the project root', () => {
  it('defaults to the working directory', () => {
    const root = copyFixture('sqlite-defaults', 'before');
    const result = spawnSync(process.execPath, [appScript], { cwd: root, encoding: 'utf8' });
    expect({ status: result.status, tree: readTree(root) }).toEqual({
      status: 0,
      tree: expectedTree('sqlite-defaults', 'after'),
    });
  });
});
