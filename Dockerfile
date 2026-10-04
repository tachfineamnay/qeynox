FROM python:3.12-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home --shell /usr/sbin/nologin qeynox

WORKDIR /app

COPY tools/requirements.txt tools/requirements.txt
RUN pip install --no-cache-dir -r tools/requirements.txt

COPY . .
RUN chmod 755 /app/docker/entrypoint.sh \
    && mkdir -p /data/stacks /data/logs \
    && chown -R qeynox:qeynox /app /data

ENV PYTHONUNBUFFERED=1 \
    QEYNOX_BIND=0.0.0.0 \
    GTM_WEB_PORT=8765 \
    QEYNOX_STACKS_DIR=/data/stacks \
    QEYNOX_LOGS_DIR=/data/logs \
    QEYNOX_MISSIONS_FILE=/data/missions.json \
    QEYNOX_LLM=none

USER qeynox
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import os,urllib.request; p=os.environ.get('GTM_WEB_PORT','8765'); urllib.request.urlopen('http://127.0.0.1:%s/api/health'%p, timeout=8).read()"]

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["python", "qeynox.py", "serve"]
