# FILE: ~/otmega/otmega_app/console/admin_backend/admin_api/static_routes.py
# ماموریت: سرو کردن shell فرانت build شده در deploy یکپارچه Cloud Run.

from pathlib import Path

from flask import Flask, Response, send_from_directory


def _fallback_shell() -> str:
    return """<!doctype html>
<html lang="fa" dir="rtl">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>OTMEGA Admin Console</title>
  </head>
  <body>
    <main style="font-family: sans-serif; padding: 32px">
      <h1>OTMEGA Admin Console</h1>
      <p>Backend is running in read-only mode. Frontend build has not been attached yet.</p>
      <p><a href="/api/console/health">/api/console/health</a></p>
    </main>
  </body>
</html>"""


def register_static_routes(app: Flask) -> None:
    static_root = Path(__file__).resolve().parents[1] / "static_frontend"

    @app.get("/")
    def console_root():
        index_file = static_root / "index.html"
        if index_file.exists():
            return send_from_directory(static_root, "index.html")
        return Response(_fallback_shell(), mimetype="text/html")

    @app.get("/<path:asset_path>")
    def console_assets(asset_path: str):
        target = static_root / asset_path
        if target.exists() and target.is_file():
            return send_from_directory(static_root, asset_path)
        index_file = static_root / "index.html"
        if index_file.exists():
            return send_from_directory(static_root, "index.html")
        return Response(_fallback_shell(), mimetype="text/html")
