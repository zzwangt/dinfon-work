import { createSeedState } from '../public/client/domain.js';

export function createApprovalWorkspace() {
  const state = createSeedState();
  state.users.find(user => user.id === 'u-admin').role = 'superadmin';
  return state;
}
