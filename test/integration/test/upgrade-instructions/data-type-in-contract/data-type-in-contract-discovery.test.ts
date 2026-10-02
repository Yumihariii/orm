import { spawnSync } from 'node:child_process';
import { lstatSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'pathe';
import { afterAll, describe, expect, it } from 'vitest';
import {
  appScript,
  copyFixture,
  expectedTree,
  makeWorkDir,
  type Run,
  readTree,
  removeWorkDirs,
  runScript,
  upgrade,
} from './test-helpers';

afterAll(removeWorkDirs);

describe('migrations outside a directory named migrations', () => {
  for (const name of ['db-migrations', 'two-migration-roots']) {
    it(`upgrades ${name}`, () => {
      const run = upgrade(name);
      expect({
        status: run.status,
        stdout: run.stdout,
        stderr: run.stderr,
        tree: readTree(run.root),
      }).toEqual({ status: 0, stdout: '', stderr: '', tree: expectedTree(name, 'after') });
    });
  }
});

describe('a project whose directories are symbolic links', () => {
  const name = 'postgres-extension-space';
  const upgraded = { status: 0, stdout: '', stderr: '' };
  const outcome = (run: Run, tree: Record<string, string>) => ({
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    tree,
  });

  it('upgrades a migrations directory that is a link to a sibling directory', () => {
    const root = copyFixture(name, 'before');
    const elsewhere = makeWorkDir(`data-type-in-contract-${name}-elsewhere-`);
    renameSync(join(root, 'migrations'), join(elsewhere, 'migrations'));
    symlinkSync(join(elsewhere, 'migrations'), join(root, 'migrations'), 'dir');
    const run = runScript(root);
    expect({
      ...outcome(run, { ...readTree(root), ...readTree(elsewhere) }),
      linkKept: lstatSync(join(root, 'migrations')).isSymbolicLink(),
    }).toEqual({ ...upgraded, tree: expectedTree(name, 'after'), linkKept: true });
  });

  it('upgrades a directory reachable through a link and through its own path once', () => {
    const root = copyFixture(name, 'before');
    renameSync(join(root, 'migrations'), join(root, 'db-history'));
    symlinkSync(join(root, 'db-history'), join(root, 'migrations'), 'dir');
    const run = runScript(root);
    const expected = Object.fromEntries(
      Object.entries(expectedTree(name, 'after')).map(([path, content]) => [
        path.replace(/^migrations\//, 'db-history/'),
        content,
      ]),
    );
    expect(outcome(run, readTree(root))).toEqual({ ...upgraded, tree: expected });
  });

  it('stops at a link that points to its own parent', () => {
    const root = copyFixture(name, 'before');
    symlinkSync(join(root, 'migrations'), join(root, 'migrations', 'loop'), 'dir');
    const run = runScript(root);
    expect(outcome(run, readTree(root))).toEqual({
      ...upgraded,
      tree: expectedTree(name, 'after'),
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
