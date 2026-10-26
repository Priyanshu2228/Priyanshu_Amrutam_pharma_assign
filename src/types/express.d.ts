import type { Role } from '../modules/auth/rbac';

export interface AuthContext {
  userId: string;
  role: Role;
  mfa: boolean;
  sessionId: string;
}

declare global {
  namespace Express {
    interface Request {
      id: string;
      auth?: AuthContext;
      /** Raw request bytes, kept for webhook signature verification. */
      rawBody?: Buffer;
    }
  }
}
