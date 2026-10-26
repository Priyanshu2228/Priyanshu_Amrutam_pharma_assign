import { AsyncLocalStorage } from 'node:async_hooks';
import type { Role } from '../modules/auth/rbac';

export interface RequestContext {
  requestId: string;
  ip?: string;
  userAgent?: string;
  actorId?: string;
  actorRole?: Role | 'system';
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  get(): RequestContext | undefined {
    return storage.getStore();
  },
  /** Attach the authenticated actor once the auth middleware has resolved it. */
  setActor(actorId: string, actorRole: Role): void {
    const store = storage.getStore();
    if (store) {
      store.actorId = actorId;
      store.actorRole = actorRole;
    }
  },
};
