# FILE: ~/otmega/otmega_app/console/admin_backend/Dockerfile
# ماموریت: ساخت container مستقل Admin Console برای deploy روی Cloud Run.
FROM python:3.11-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=True

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8080
CMD exec gunicorn --bind "0.0.0.0:$PORT" --timeout "${GUNICORN_TIMEOUT_SECONDS:-150}" --graceful-timeout "${GUNICORN_GRACEFUL_TIMEOUT_SECONDS:-30}" app:app
