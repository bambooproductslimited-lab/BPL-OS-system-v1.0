// Mirrors kernel.js's fail(code, message) — the same error codes the frontend
// already branches on (auth / forbidden / invalid / notfound / conflict),
// mapped to real HTTP status codes here instead of an { ok:false } envelope.
var STATUS_BY_CODE = {
  invalid: 400,
  auth: 401,
  forbidden: 403,
  notfound: 404,
  conflict: 409,
  error: 500
};

class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = STATUS_BY_CODE[code] || 500;
  }
}

function fail(code, message) {
  throw new AppError(code, message);
}

module.exports = { AppError: AppError, fail: fail, STATUS_BY_CODE: STATUS_BY_CODE };
