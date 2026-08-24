# The trial container: stock Node 24.19.0 (the version .tool-versions pins and
# the corpus was materialised with) plus the commodity lazy-OCI substrate
# (nydus v2.4.5 static, linux/arm64) and the in-container workload driver.
#
# socket.io-client is installed HERE, not taken from the application tree, so
# the uptime-kuma held-out phase's own module loads are never charged to the
# application's remote-fetch account.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      fuse3 iproute2 curl ca-certificates procps jq \
    && rm -rf /var/lib/apt/lists/*
COPY nydus-static/nydusd nydus-static/nydus-image nydus-static/nydusctl /usr/local/bin/
RUN mkdir -p /opt/driver && cd /opt/driver && npm init -y >/dev/null \
    && npm i --no-audit --no-fund socket.io-client@4.8.3 >/dev/null
COPY driver.mjs sampler.mjs runner.sh tracer.cjs /opt/driver/
RUN chmod +x /opt/driver/runner.sh && nydusd --version && nydus-image --version
