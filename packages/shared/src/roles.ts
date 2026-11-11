/** E9-1 roles and the permission matrix. Deny by default: a permission not listed here is refused. */
export const ROLES = ['owner', 'admin', 'clerk', 'approver', 'viewer', 'accountant'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  clerk: 'Clerk (create only)',
  approver: 'Approver',
  viewer: 'Viewer',
  accountant: 'Accountant',
};

export const PERMISSIONS = {
  'workspace.view': ['owner', 'admin', 'clerk', 'approver', 'viewer', 'accountant'],
  'workspace.manage': ['owner', 'admin', 'accountant'],
  'members.manage': ['owner', 'admin'],
  'records.edit': ['owner', 'admin', 'clerk', 'accountant'],
  'invoices.edit': ['owner', 'admin', 'clerk', 'accountant'],
  'invoices.submit': ['owner', 'admin', 'approver', 'accountant'],
  'invoices.approve': ['owner', 'approver'],
  'invoices.share': ['owner', 'admin', 'clerk', 'approver', 'accountant'],
  'audit.view': ['owner', 'admin', 'accountant'],
  'reports.view': ['owner', 'admin', 'approver', 'viewer', 'accountant'],
  'vat.declare': ['owner', 'admin', 'accountant'],
  'invoices.payments': ['owner', 'admin', 'clerk', 'accountant'],
  'b2c.manage': ['owner', 'admin', 'clerk', 'accountant'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

/** NFR-7: these roles must have two-step verification turned on. */
export const ROLES_REQUIRING_2FA: readonly Role[] = ['owner', 'admin', 'accountant'];
export const requires2fa = (role: Role) => ROLES_REQUIRING_2FA.includes(role);
