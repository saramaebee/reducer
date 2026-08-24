#!/usr/bin/env bash
# One measured trial, inside one throwaway container.
#
#   t0 = the instant the image is asked for. Everything before t0 is
#   scaffolding a real deployment does once (bootstrap staged locally, database
#   created, tc configured) and is deliberately charged to no arm.
#
# Lazy arms:  nydusd (commodity lazy OCI) + overlayfs, exactly as a snapshotter
#             mounts it.  Eager arms (A1/A2): the same overlay over a plain
#             directory, so the only difference is where bytes come from.
#
# Environment: ARM MODE SPEC
#   lazy:  ARM REPO BLOB PREFETCH PREFETCH_ALL WAIT_ALL BOOTSTRAP
#   eager: EAGER_APP
set -u
ms(){ date +%s%3N; }
say(){ echo "#M $1 $(ms)"; }

# /work is a docker VOLUME, not the container's overlay layer: overlayfs
# refuses an upperdir that is itself overlayfs. Wiping it here (pre-t0) is the
# cold-start reset for the blobcache — no trial may inherit another's bytes.
rm -rf /work/* /work/.[!.]* 2>/dev/null
mkdir -p /work/cache /mnt/rafs /work/up /work/wd /mnt/app /scratch /out
cp "$SPEC" /work/spec.json
[ -n "${BOOTSTRAP:-}" ] && cp "$BOOTSTRAP" /work/boot.img

# Network shaping lives on the REGISTRY container, not here: `tc netem rate`
# only limits the direction it is attached to, and blob fetches are DOWNLOAD.
# Shaping the app container's egress would delay its requests while leaving the
# response bandwidth unlimited — a lazy-loading benchmark with no bandwidth
# cost at all. See shapeNetwork() in run.ts.

envfile(){ node -e 'const s=require("/work/spec.json");for(const[k,v]of Object.entries(s.env))process.stdout.write(`export ${k}=${JSON.stringify(v)}\n`)'; }
cwdrel(){ node -e 'const s=require("/work/spec.json");process.stdout.write(s.cwdRel||"")'; }

# ---- scaffolding (DB create/migrate/seed) runs against the EAGER copy, never
# the lazy mount: warming the cache here would prefetch for whichever arm ran.
# Written as ONE script, not eval'd line by line: several recipes' setup
# commands are multi-line (backslash continuations inside a printf), and
# splitting them silently produced a half-written config file.
node -e 'const s=require("/work/spec.json");process.stdout.write((s.setup||[]).join("\n")+"\n")' > /work/setup.sh
if [ -s /work/setup.sh ]; then
  envfile > /work/env.sh
  CR=$(cwdrel)
  ( . /work/env.sh; cd "/eager${CR:+/$CR}" 2>/dev/null || cd /eager
    bash /work/setup.sh > /work/setup.log 2>&1 || true )
fi
say setup-done

# ---------------------------------------------------------------- t0
say t0
if [ -n "${EAGER_APP:-}" ]; then
  mount -t overlay overlay -o "lowerdir=$EAGER_APP,upperdir=/work/up,workdir=/work/wd" /mnt/app || say overlay-failed
  LAZY=0
else
  LAZY=1
  cat > /work/cfg.json <<EOF
{"device":{"backend":{"type":"registry","config":{"scheme":"http","host":"reducer-registry:5000","repo":"$REPO","timeout":60,"connect_timeout":10,"retry_limit":2}},
 "cache":{"type":"blobcache","config":{"work_dir":"/work/cache"}}},
 "mode":"direct","digest_validate":false,"iostats_files":true,"access_pattern":true,"latest_read_files":true,
 "fs_prefetch":{"enable":$PREFETCH,"threads_count":4,"merging_size":131072,"prefetch_all":$PREFETCH_ALL}}
EOF
  nydusd --config /work/cfg.json --mountpoint /mnt/rafs --bootstrap /work/boot.img \
         --apisock /work/api.sock --log-level warn > /work/nydusd.log 2>&1 &
  for _ in $(seq 1 4000); do mountpoint -q /mnt/rafs && break; sleep 0.005; done
  mount -t overlay overlay -o lowerdir=/mnt/rafs,upperdir=/work/up,workdir=/work/wd /mnt/app || say overlay-failed
fi
say mount

SAMPLER=""
if [ "$LAZY" = "1" ]; then
  node /opt/driver/sampler.mjs /work/api.sock /work/samples.jsonl &
  SAMPLER=$!
  if [ "${WAIT_ALL:-0}" = "1" ]; then
    # B0 = the docker-pull analogue: nothing starts until the image is local.
    # `data_all_ready` is NOT that signal (it stays false even after a complete
    # prefetch_all); the blobcache's prefetch END TIMESTAMP is.
    for _ in $(seq 1 60000); do
      [ "$(curl -s --unix-socket /work/api.sock http://localhost/api/v1/metrics/blobcache | jq -r .prefetch_end_time_secs)" != "0" ] && break
      sleep 0.02
    done
    say all-ready
  fi
fi

# ---- application
envfile > /work/appenv.sh
# shellcheck disable=SC1091
. /work/appenv.sh
CR=$(cwdrel)
mapfile -t ARGV < <(node -e 'const s=require("/work/spec.json");for(const a of s.argv)console.log(a)')
say proc
# OBSERVE runs (never a measured trial) preload the experiment-2 observe-only
# tracer, because nydusd's /api/v1/metrics/files response is truncated at
# ~290 KB and cannot carry a per-file ground truth for a real application.
( cd "/mnt/app${CR:+/$CR}" 2>/dev/null || cd /mnt/app
  if [ "${OBSERVE:-0}" = "1" ]; then
    mkdir -p /work/trace
    export NODE_OPTIONS="--require /opt/driver/tracer.cjs"
    export HYDRATION_TRACE_DIR=/work/trace HYDRATION_APP_ROOT=/mnt/app HYDRATION_RUN_LABEL="$ARM"
  fi
  exec node "${ARGV[@]}" ) > /work/app.log 2>&1 &
APP=$!

node /opt/driver/driver.mjs /work/spec.json "$MODE" /work/events.jsonl
DRV=$?
say workload-done

# ---- collection: after the measured window, so no virtiofs write is timed
if [ "$LAZY" = "1" ]; then
  for m in metrics metrics/backend metrics/blobcache metrics/pattern metrics/files; do
    n=$(echo "$m" | tr '/' '.')
    curl -s --unix-socket /work/api.sock "http://localhost/api/v1/$m" > "/out/final.${n}.json"
  done
fi
say collect
kill "$APP" 2>/dev/null
sleep 0.3
[ -n "$SAMPLER" ] && kill "$SAMPLER" 2>/dev/null
cp /work/samples.jsonl /out/samples.jsonl 2>/dev/null
cp /work/setup.log /out/setup.log 2>/dev/null
[ -d /work/trace ] && cp -r /work/trace /out/trace 2>/dev/null
cp /work/events.jsonl /out/events.jsonl 2>/dev/null
tail -c 40000 /work/app.log > /out/app.log 2>/dev/null
tail -c 20000 /work/nydusd.log > /out/nydusd.log 2>/dev/null
cat /sys/fs/cgroup/cpu.stat > /out/cpu.stat 2>/dev/null
echo "#M done $(ms) driver=$DRV"
exit 0
