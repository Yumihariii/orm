import { execFileSync } from 'node:child_process';

/**
 * Paths of committed JSON files that are not the repository's own contracts: the upgrade script's test fixtures (synthetic, some in the old format) and the old-format contract that tests the refusal.
 */
const notRepositoryContracts = [
  ':!test/integration/test/upgrade-instructions/data-type-in-contract/fixtures',
  ':!test/integration/test/fixtures/contract-format/supabase-before-dbgenerated-removal.contract.json',
];

/** Every committed `*.json` file that may be one of the repository's own contracts, sorted. */
export function trackedContractCandidateFiles(repoRoot: string): readonly string[] {
  return execFileSync('git', ['ls-files', '-z', '--', '*.json', ...notRepositoryContracts], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file !== '')
    .sort();
}
