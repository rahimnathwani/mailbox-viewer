# Everything needed to build and preview mailboxes: Python (uv), Node.js, readpst.
#
#   docker compose run --rm mbv build input/mailbox.pst --slug my-mailbox
#   docker compose up        # http://localhost:8000
FROM node:22-bookworm-slim

COPY --from=ghcr.io/astral-sh/uv:0.12.17 /uv /uvx /usr/local/bin/
RUN apt-get update \
 && apt-get install -y --no-install-recommends pst-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV UV_LINK_MODE=copy \
    UV_PYTHON_INSTALL_DIR=/opt/python \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_COMPILE_BYTECODE=1 \
    MBV_CACHE=/cache \
    PATH=/opt/venv/bin:$PATH
WORKDIR /app

# dependencies first, for layer caching
COPY pyproject.toml uv.lock README.md LICENSE hatch_build.py ./
COPY src/mailbox_viewer/__init__.py src/mailbox_viewer/__init__.py
RUN uv sync --frozen --no-dev --no-install-project
COPY viewer/package.json viewer/package-lock.json viewer/
RUN npm ci --prefix viewer --ignore-scripts --no-audit --no-fund

COPY . .
RUN npm run build --prefix viewer \
 && uv sync --frozen --no-dev \
 && python -c "from mailbox_viewer.embed import embed_dir; embed_dir()"

WORKDIR /work
ENTRYPOINT ["mbv"]
CMD ["preview", "--host", "0.0.0.0"]
