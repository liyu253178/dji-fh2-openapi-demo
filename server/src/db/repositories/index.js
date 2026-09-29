/**
 * 仓储层统一出口
 *
 * 服务层统一从 `import { patchRepo } from '../db/repositories/index.js'` 取用。
 */

export { syncRepo, assetRepo, dictRepo, alertRepo } from './miscRepo.js';
export {
  patchRepo,
  patchImageRepo,
  ticketRepo,
  TICKET_STATUS,
  allowedTransitions,
  canTransit,
} from './ticketRepo.js';
