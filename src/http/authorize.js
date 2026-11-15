// =====================================================================
// authorize.js: what may each role do? (authorisation, D41)
//
// One table, in one place. A route declares the permission it needs;
// requirePermission() answers 403 if the caller's role lacks it.
// =====================================================================

export const PERMISSIONS = Object.freeze({
  read:              ['OFFICER', 'MANAGER', 'AUDITOR'], // view borrowers, loans, schedules, products
  'borrower:create': ['OFFICER', 'MANAGER'],
  'loan:create':     ['OFFICER', 'MANAGER'],
  'loan:disburse':   ['MANAGER'],                       // D42: maker-checker, officers can't release money
  'repayment:post':  ['OFFICER', 'MANAGER'],
  'ledger:read':     ['MANAGER', 'AUDITOR'],            // trial balance
  'audit:read':      ['MANAGER', 'AUDITOR'],
});

export function can(role, permission) {
  const allowed = PERMISSIONS[permission];
  if (!allowed) throw new Error(`Unknown permission ${permission}`);
  return allowed.includes(role);
}

/** Express middleware. Throws at startup if a route names a permission that doesn't exist. */
export function requirePermission(permission) {
  if (!PERMISSIONS[permission]) throw new Error(`Unknown permission ${permission}`);
  return (req, res, next) => {
    if (can(req.user.role, permission)) return next();
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: `Role ${req.user.role} is not allowed to ${permission}` },
    });
  };
}