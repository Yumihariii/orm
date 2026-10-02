import type { Contract as End } from '../../snapshots/374994e918ff79ba722051dfd010b32ffc5bf733151c8682c0bfa368bf9cfe94/contract';
import endContract from '../../snapshots/374994e918ff79ba722051dfd010b32ffc5bf733151c8682c0bfa368bf9cfe94/contract.json' with {
  type: 'json',
};

export const contracts = { start: null, end: endContract };
export type Contracts = { start: never; end: End };
