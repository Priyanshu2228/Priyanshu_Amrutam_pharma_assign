export const ROLES = ['patient', 'doctor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Coarse permissions checked at the route layer. Ownership ("is this MY consultation?")
 * is enforced in services because it depends on the loaded record.
 */
export const PERMISSIONS = {
  'profile:manage': ['patient', 'doctor', 'admin'],
  'doctor:read': ['patient', 'doctor', 'admin'],
  'doctor:profile:manage': ['doctor'],
  'slot:read': ['patient', 'doctor', 'admin'],
  'slot:manage': ['doctor'],
  'consultation:book': ['patient'],
  'consultation:read': ['patient', 'doctor', 'admin'],
  'consultation:cancel': ['patient', 'doctor', 'admin'],
  'consultation:conduct': ['doctor'],
  'prescription:write': ['doctor'],
  'prescription:read': ['patient', 'doctor'],
  'payment:confirm': ['patient'],
  'admin:analytics': ['admin'],
  'admin:audit': ['admin'],
  'admin:users': ['admin'],
  'admin:doctors': ['admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
