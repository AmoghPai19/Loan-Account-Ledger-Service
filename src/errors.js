// =====================================================================
// errors.js: error types the service layer throws. Step 4's HTTP layer
// turns each one into a status code, so services never deal with HTTP.
// =====================================================================

export class AppError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;   // HTTP status code to use in Step 4
    this.code = code;       // stable machine-readable code for API clients
    this.details = details;
  }
}

/** The request itself is wrong (bad amount, date, tenure ...). HTTP 400. */
export class ValidationError extends AppError {
  constructor(message, details) { super(message, 400, 'VALIDATION_ERROR', details); }
}

/** The thing asked for does not exist. HTTP 404. */
export class NotFoundError extends AppError {
  constructor(message) { super(message, 404, 'NOT_FOUND'); }
}

/** The request is valid but clashes with the current state (e.g. disbursing twice). HTTP 409. */
export class ConflictError extends AppError {
  constructor(message, details) { super(message, 409, 'CONFLICT', details); }
}