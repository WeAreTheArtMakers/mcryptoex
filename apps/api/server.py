from __future__ import annotations

import json
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def _write_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _write_text(self, status: int, payload: str, content_type: str = "text/plain; version=0.0.4") -> None:
        body = payload.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        now = datetime.now(timezone.utc).isoformat()
        if self.path == "/":
            self._write_json(
                200,
                {
                    "service": "tempo-api-placeholder",
                    "status": "ok",
                    "timestamp": now,
                },
            )
            return

        if self.path in ("/health", "/health/ready"):
            self._write_json(200, {"status": "ok", "timestamp": now})
            return

        if self.path == "/metrics":
            metrics = (
                "# HELP mcryptoex_api_up API placeholder up indicator\n"
                "# TYPE mcryptoex_api_up gauge\n"
                "mcryptoex_api_up 1\n"
            )
            self._write_text(200, metrics)
            return

        self._write_json(404, {"error": "not_found", "path": self.path})

    def log_message(self, fmt: str, *args) -> None:
        # Keep container logs concise in Phase 1.
        return


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", 8000), Handler)
    print("tempo-api-placeholder listening on :8000", flush=True)
    server.serve_forever()
