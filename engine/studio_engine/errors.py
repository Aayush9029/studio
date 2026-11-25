"""Error codes (API_CONTRACT.md Appendix C)."""
from __future__ import annotations

STATUS = {
    "BAD_REQUEST": 400,
    "INVALID_DIMENSIONS": 400,
    "UNKNOWN_FAMILY": 400,
    "IMAGE_DECODE_FAILED": 400,
    "FORBIDDEN_ORIGIN": 403,
    "NOT_FOUND": 404,
    "BUSY": 409,
    "IMAGE_TOO_LARGE": 413,
    "UNSUPPORTED_MEDIA_TYPE": 415,
    "MODEL_FILES_MISSING": 424,
    "OUT_OF_MEMORY": 507,
    "SHUTTING_DOWN": 503,
    "INTERNAL": 500,
}


class ApiError(Exception):
    def __init__(self, code: str, message: str = "", details: dict | None = None, status: int | None = None):
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.details = details
        self.status = status or STATUS.get(code, 500)

    def body(self) -> dict:
        err = {"code": self.code, "message": self.message}
        if self.details is not None:
            err["details"] = self.details
        return {"error": err}

    def as_error(self) -> dict:
        return {"code": self.code, "message": self.message, "details": self.details or {}}


class JobCancelled(Exception):
    """Raised inside a pipeline when the active job was cancelled."""


def bad(field: str, message: str) -> ApiError:
    return ApiError("BAD_REQUEST", message, {"field": field})
