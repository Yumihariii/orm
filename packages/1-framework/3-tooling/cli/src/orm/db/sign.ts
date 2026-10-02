import type { PrismaNextConfig } from '@internal/config/config-types';
import { ormConfigSection } from '@internal/config-loader';
import type { Contract } from '@internal/contract/types';
import { APP_SPACE_ID, createControlStack } from '@internal/framework-components/control';
import { MigrationToolsError } from '@internal/migration-tools/errors';
import { readRef, writeRef } from '@internal/migration-tools/refs';
import { spaceMigrationDirectory, spaceRefsDirectory } from '@internal/migration-tools/spaces';
import { ifDefined } from '@internal/utils/defined';
import { notOk as notOkResult, ok as okResult, type Result } from '@internal/utils/result';
import type { Block, Presentations, Span, Text, TreeNode } from '@prisma/cli-engine';
import { flag, positional } from '@prisma/cli-engine';
import type { Diagnostic } from '@prisma/cli-engine/protocol';
import { notOk, ok } from '@prisma/cli-engine/protocol';
import { createControlClient } from '../../control-api/client';
import { resolveContractRefToSnapshot } from '../../control-api/operations/contract-snapshot-resolution';
import type { DbSignSpaceOutcome } from '../../control-api/operations/db-sign';
import {
  advanceRefSafely,
  type ContractIR,
  preflightRefAdvancement,
} from '../../control-api/operations/ref-advancement';
import {
  type CliStructuredError,
  errorAdvanceRefArgConflict,
  errorContractArgConflict,
  errorContractValidationFailed,
} from '../../utils/cli-errors';
import { closeQuietly, maskConnectionUrl } from '../../utils/command-helpers';
import { defineOrmCommand } from '../define-command';
import { dbFlag } from '../flags';
import { appRefsDirFor, baseDirFor, migrationsDirFor } from '../migration/paths';
import { normalizeError } from '../normalize-error';
import { controlProgressReporter } from '../progress';
import {
  issueNodes,
  readEmittedContract,
  requireVerifyConnection,
  schemaDriftNextActions,
  schemaVerdictDiagnostic,
  verificationThrow,
} from './verification';

/**
 * Verification ran and refused the signature. The command completed — it
 * answered the question "may this database be signed?" — so the refusal is a
 * diagnostic on a completed envelope rather than an error.
 */
const FINDINGS_EXIT_CODE = 4;

/**
 * The ref a signature checkpoints. Unlike `db init` / `db update`, `--db` does
 * not suppress the write: signing does not touch the schema, and adoption is
 * normally done against the real database via `--db`. Only `--no-advance-ref`
 * suppresses it.
 */
const DEFAULT_ADVANCE_REF = 'db';

interface AdvancedRef {
  readonly space: string;
  readonly name: string;
  readonly hash: string;
}

const NO_PREVIOUS_HASH_CODES: ReadonlySet<string> = new Set([
  'MIGRATION.UNKNOWN_REF',
  'MIGRATION.INVALID_REF_FILE',
  'MIGRATION.INVALID_REF_NAME',
]);

/**
 * The hash the ref held before the signature, read from that one ref file so a
 * corrupt sibling cannot fail a signature already written.
 */
async function previousRefHash(refsDir: string, name: string): Promise<string | undefined> {
  try {
    return (await readRef(refsDir, name)).hash;
  } catch (error) {
    if (MigrationToolsError.is(error) && NO_PREVIOUS_HASH_CODES.has(error.code)) {
      return undefined;
    }
    throw error;
  }
}

interface DbSignDocument {
  readonly ok: boolean;
  readonly summary: string;
  readonly spaces: readonly DbSignSpaceOutcome[];
  readonly advancedRefs: readonly AdvancedRef[];
}

/** The contract that was signed, as the bytes the snapshot store keeps. */
interface SignedContractSource {
  readonly json: Record<string, unknown>;
  readonly jsonPath: string;
}

function headerBlock(inputs: { readonly contract: string; readonly database: string }): Block {
  return {
    kind: 'fields',
    rail: true,
    rows: [
      { label: 'contract', value: inputs.contract },
      { label: 'database', value: inputs.database },
    ],
  };
}

function hashSpans(hash: string, previousHash: string | undefined): readonly Span[] {
  return [
    { text: hash, tone: 'identifier' },
    ...(previousHash === undefined
      ? []
      : [
          { text: ' (was ', tone: 'muted' as const },
          { text: previousHash, tone: 'identifier' as const },
          { text: ')', tone: 'muted' as const },
        ]),
  ];
}

function spaceNode(outcome: DbSignSpaceOutcome): TreeNode {
  switch (outcome.status) {
    case 'signed':
      return {
        label: [
          { text: `${outcome.space}: signed ` },
          ...(outcome.marker.previous === undefined
            ? [
                { text: outcome.contract.storageHash, tone: 'identifier' as const },
                { text: ' (no marker before)', tone: 'muted' as const },
              ]
            : hashSpans(outcome.contract.storageHash, outcome.marker.previous.storageHash)),
        ],
        status: 'ok',
      };
    case 'unchanged':
      return {
        label: [
          { text: `${outcome.space}: unchanged, already signed with ` },
          { text: outcome.contract.storageHash, tone: 'identifier' },
        ],
        status: 'ok',
      };
    case 'failed':
      return {
        label: `${outcome.space}: not signed, the schema does not satisfy its contract`,
        status: 'error',
        children: issueNodes(outcome.schema.schema.issues, 'error'),
      };
    case 'changed':
      return {
        label: `${outcome.space}: not signed, its marker changed after the schema was verified`,
        status: 'error',
        children: [
          {
            label: `marker when verified: ${outcome.markerChanged.verified?.storageHash ?? 'none'}`,
            status: 'error',
          },
          {
            label: `marker now: ${outcome.markerChanged.found?.storageHash ?? 'none'}`,
            status: 'error',
          },
        ],
      };
  }
}

function isSigned(outcome: DbSignSpaceOutcome): boolean {
  return outcome.status === 'signed' || outcome.status === 'unchanged';
}

function quotedList(spaces: readonly DbSignSpaceOutcome[]): string {
  return spaces.map((outcome) => `"${outcome.space}"`).join(', ');
}

function signSummary(spaces: readonly DbSignSpaceOutcome[]): string {
  const failed = spaces.filter((outcome) => outcome.status === 'failed');
  const changed = spaces.filter((outcome) => outcome.status === 'changed');
  if (failed.length === 0 && changed.length === 0) {
    return 'Database signed';
  }
  const signed = spaces.filter(isSigned);
  const problems = [
    ...(failed.length === 0
      ? []
      : [
          `Database schema does not satisfy contract for ${failed.length === 1 ? 'space' : 'spaces'} ${quotedList(failed)}`,
        ]),
    ...(changed.length === 0
      ? []
      : [
          `${changed.length === 1 ? 'marker of space' : 'markers of spaces'} ${quotedList(changed)} changed while db sign ran`,
        ]),
  ].join('; ');
  const signedText = signed.length === 0 ? 'signed nothing' : `signed ${quotedList(signed)}`;
  return `${problems.charAt(0).toUpperCase()}${problems.slice(1)}; ${signedText}`;
}

function markerChangedDiagnostic(
  outcome: Extract<DbSignSpaceOutcome, { readonly status: 'changed' }>,
): Diagnostic {
  const { verified, found } = outcome.markerChanged;
  return {
    code: 'MIGRATION.MARKER_CAS_FAILURE',
    severity: 'error',
    summary: `Marker of space "${outcome.space}" changed while db sign ran`,
    why: `Another process, such as migrate, changed the marker from ${verified?.storageHash ?? 'no marker'} to ${found?.storageHash ?? 'no marker'} after db sign read it, so db sign did not sign the space.`,
    nextActions: [
      {
        kind: 'run-command',
        label: 'Sign again once the other process has finished',
        command: '{bin} db sign',
      },
    ],
    meta: {
      space: outcome.space,
      verifiedStorageHash: verified?.storageHash ?? null,
      foundStorageHash: found?.storageHash ?? null,
    },
  };
}

function advancedRefSpans(
  advanced: AdvancedRef & { readonly previousHash: string | undefined },
): Text {
  const subject =
    advanced.space === APP_SPACE_ID
      ? `Advanced ref "${advanced.name}" → `
      : `Advanced ref "${advanced.name}" of space "${advanced.space}" → `;
  return [{ text: subject }, ...hashSpans(advanced.hash, advanced.previousHash)];
}

function signPresentations(inputs: {
  readonly document: DbSignDocument;
  readonly advanced:
    | readonly (AdvancedRef & { readonly previousHash: string | undefined })[]
    | null;
  readonly header: Block;
}): Presentations {
  const { document } = inputs;
  return {
    stdout: () => [],
    next: () => [],
    human: (): readonly Block[] => [
      inputs.header,
      { kind: 'tree', roots: document.spaces.map(spaceNode) },
      { kind: 'summary', status: document.ok ? 'ok' : 'error', text: document.summary },
      ...(inputs.advanced === null
        ? [
            {
              kind: 'summary' as const,
              status: 'info' as const,
              tone: 'muted' as const,
              text: `Left ref "${DEFAULT_ADVANCE_REF}" untouched (--no-advance-ref)`,
            },
          ]
        : inputs.advanced.map((advanced) => ({
            kind: 'summary' as const,
            status: 'ok' as const,
            text: advancedRefSpans(advanced),
          }))),
    ],
    json: () => document,
  };
}

function hydrateContract(
  config: PrismaNextConfig,
  json: unknown,
  path: string,
): Result<Contract, CliStructuredError> {
  try {
    return okResult(config.family.create(createControlStack(config)).deserializeContract(json));
  } catch (error) {
    return notOkResult(
      errorContractValidationFailed(
        `Contract JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
        { where: { path } },
      ),
    );
  }
}

/**
 * Writes the named ref of an extension space. Its contract snapshot is already in the store: the aggregate read the space's contract from it.
 */
async function advanceExtensionRef(args: {
  readonly migrationsDir: string;
  readonly space: string;
  readonly name: string;
  readonly hash: string;
}): Promise<Result<void, CliStructuredError>> {
  const refsDir = spaceRefsDirectory(spaceMigrationDirectory(args.migrationsDir, args.space));
  try {
    await writeRef(refsDir, args.name, { hash: args.hash, invariants: [] });
    return okResult(undefined);
  } catch (error) {
    if (MigrationToolsError.is(error)) {
      return notOkResult(error);
    }
    throw error;
  }
}

/**
 * Builds the command with its control-client factory injected, so tests mount
 * the same tree over a fake client instead of mocking the client module.
 */
export function createDbSignCommand(
  createClient: typeof createControlClient = createControlClient,
) {
  return defineOrmCommand({
    help: {
      summary: 'Sign the database with your contract so you can safely run queries',
      description:
        'Verifies that your database schema satisfies the emitted contract and the\n' +
        'contract of every extension that ships one, and writes or updates the\n' +
        'signature of each that does, in one transaction. A signature records that\n' +
        'this database instance is aligned with a specific contract version.\n' +
        'Idempotent. After signing, the db ref of each signed space is advanced to\n' +
        'its contract; pass --no-advance-ref to sign without touching any ref,\n' +
        'which is what a CI or deployment pipeline usually wants.\n' +
        'Exit codes: 0 = signed, 2 = the command could not run (unresolvable\n' +
        'contract reference, no emitted contract, unreachable database),\n' +
        '4 = schema verification failed for a space,\n' +
        'or its marker changed while db sign ran; its signature was not written.',
      examples: [
        'db sign',
        'db sign --db $DATABASE_URL',
        'db sign production --db $DATABASE_URL',
        'db sign --contract production --db $DATABASE_URL',
        'db sign --db $DATABASE_URL --advance-ref production',
        'db sign --db $DATABASE_URL --no-advance-ref',
      ],
    },
    args: {
      positionals: {
        contract: positional.optionalString({
          brief: 'Contract reference (hash, prefix, ref name, or migration dir name)',
          placeholder: 'contract',
        }),
      },
      flags: {
        db: dbFlag,
        contract: flag.string({
          brief:
            'Contract reference (hash, prefix, ref name, migration dir name, <dir>^, or ./path)',
          placeholder: 'contract',
        }),
        advanceRef: flag.string({
          brief: 'Advance the named ref to the post-command contract hash',
          placeholder: 'name',
        }),
        noAdvanceRef: flag.boolean({
          brief: 'Sign without advancing any ref (no ref file or snapshot is written)',
        }),
      },
    },
    needs: { config: ormConfigSection },
    exitCodes: {
      4: 'schema verification failed for a space, or its marker changed while db sign ran; its signature was not written',
    },
    handler: async (args, ctx) => {
      const positionalContract = args.positionals.contract;
      const flagContract = args.flags.contract;
      if (positionalContract !== undefined && flagContract !== undefined) {
        return notOk(
          normalizeError(
            errorContractArgConflict({ positional: positionalContract, flag: flagContract }),
          ),
        );
      }
      const contractRef = positionalContract ?? flagContract;
      if (args.flags.noAdvanceRef && args.flags.advanceRef !== undefined) {
        return notOk(
          normalizeError(errorAdvanceRefArgConflict({ advanceRef: args.flags.advanceRef })),
        );
      }

      const emitted = await readEmittedContract({
        config: ctx.config,
        cwd: ctx.cwd,
        commandName: 'db sign',
      });
      if (!emitted.ok) {
        return notOk(emitted.failure);
      }

      const migrationsDir = migrationsDirFor(ctx.config);
      let contract: Contract = emitted.value.contract;
      let signedSource: SignedContractSource;
      if (contractRef !== undefined) {
        const resolvedRef = await resolveContractRefToSnapshot({
          config: ctx.config,
          migrationsDir,
          refInput: contractRef,
          contractPathAbsolute: emitted.value.path,
          fallbackToEmitted: true,
        });
        if (!resolvedRef.ok) {
          return notOk(normalizeError(resolvedRef.failure));
        }
        const hydrated = hydrateContract(
          ctx.config,
          resolvedRef.value.contractJson,
          resolvedRef.value.contractJsonPath,
        );
        if (!hydrated.ok) {
          return notOk(normalizeError(hydrated.failure));
        }
        contract = hydrated.value;
        signedSource = {
          json: resolvedRef.value.contractJson,
          jsonPath: resolvedRef.value.contractJsonPath,
        };
      } else {
        signedSource = { json: emitted.value.json, jsonPath: emitted.value.path };
      }

      const client = createClient({
        family: ctx.config.family,
        target: ctx.config.target,
        adapter: ctx.config.adapter,
        ...ifDefined('driver', ctx.config.driver),
        extensions: ctx.config.extensions ?? [],
      });

      const refName = args.flags.noAdvanceRef
        ? null
        : (args.flags.advanceRef ?? DEFAULT_ADVANCE_REF);
      let advancement: { readonly name: string; readonly contractIR: ContractIR } | null = null;
      if (refName !== null) {
        const preflight = await preflightRefAdvancement({
          name: refName,
          contractJson: signedSource.json,
          contractJsonPath: signedSource.jsonPath,
          projectDir: baseDirFor(ctx.config),
          client,
        });
        if (!preflight.ok) {
          return notOk(normalizeError(preflight.failure));
        }
        advancement = { name: refName, contractIR: preflight.value };
      }

      const connection = requireVerifyConnection({
        config: ctx.config,
        db: args.flags.db,
        invocation: 'db sign',
      });
      if (!connection.ok) {
        return notOk(connection.failure);
      }
      const dbConnection = connection.value;

      const header = headerBlock({
        contract: contractRef ?? emitted.value.displayPath,
        database: maskConnectionUrl(dbConnection),
      });

      try {
        const signed = await client.dbSign({
          contract,
          migrationsDir,
          connection: dbConnection,
          onProgress: controlProgressReporter(ctx.report),
        });
        if (!signed.ok) {
          return notOk(normalizeError(signed.failure));
        }
        const spaces = signed.value.spaces;

        const advanced: (AdvancedRef & { readonly previousHash: string | undefined })[] = [];
        if (advancement !== null) {
          for (const outcome of spaces) {
            if (!isSigned(outcome)) continue;
            const hash = outcome.contract.storageHash;
            const isApp = outcome.space === APP_SPACE_ID;
            const refsDir = isApp
              ? appRefsDirFor(ctx.config)
              : spaceRefsDirectory(spaceMigrationDirectory(migrationsDir, outcome.space));
            const previousHash = await previousRefHash(refsDir, advancement.name);
            const written = isApp
              ? await advanceRefSafely({
                  refsDir,
                  migrationsDir,
                  name: advancement.name,
                  hash,
                  contractIR: advancement.contractIR,
                })
              : await advanceExtensionRef({
                  migrationsDir,
                  space: outcome.space,
                  name: advancement.name,
                  hash,
                });
            if (!written.ok) {
              return notOk(normalizeError(written.failure));
            }
            advanced.push({ space: outcome.space, name: advancement.name, hash, previousHash });
          }
        }

        const unsigned = spaces.filter((outcome) => !isSigned(outcome));
        const document: DbSignDocument = {
          ok: unsigned.length === 0,
          summary: signSummary(spaces),
          spaces,
          advancedRefs: advanced.map(({ space, name, hash }) => ({ space, name, hash })),
        };
        const diagnostics: Diagnostic[] = spaces.flatMap((outcome) => {
          switch (outcome.status) {
            case 'failed':
              return [
                schemaVerdictDiagnostic({
                  result: outcome.schema,
                  space: outcome.space,
                  nextActions: schemaDriftNextActions({
                    verb: 'sign',
                    contractRef,
                    issues: outcome.schema.schema.issues,
                  }),
                }),
              ];
            case 'changed':
              return [markerChangedDiagnostic(outcome)];
            default:
              return [];
          }
        });
        return ok(
          ctx.present(
            {
              data: document,
              exitCode: unsigned.length === 0 ? 0 : FINDINGS_EXIT_CODE,
              ...(diagnostics.length === 0 ? {} : { diagnostics }),
            },
            signPresentations({
              document,
              advanced: advancement === null ? null : advanced,
              header,
            }),
          ),
        );
      } catch (error) {
        return notOk(verificationThrow({ error, invocation: 'db sign', connection: dbConnection }));
      } finally {
        await closeQuietly(client);
      }
    },
  });
}

export const dbSignCommand = createDbSignCommand();
