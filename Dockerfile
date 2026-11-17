FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MELECHO_DOCKER=1

WORKDIR /app

COPY pyproject.toml README.md LICENSE ./
COPY src/ ./src/

RUN pip install --no-cache-dir .

EXPOSE 8765

VOLUME ["/root/.local/share/melecho", "/root/.config/melecho"]

ENTRYPOINT ["melecho", "--foreground", "--no-browser", "--bind", "0.0.0.0"]
