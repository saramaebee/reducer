#!/usr/bin/env bash
# One measured trial of the long-tail traffic-warm experiment, inside one
# throwaway container.
#
#   t0 = the instant the image is asked for. Everything before t0 is scaffolding
#   a real deployment does once (bootstrap staged locally, database created,
#   tc configured) and is deliberately charged to no arm.
#
# The substrate is IDENTICAL for every arm: the same nydus image, the same blob,
# the same bootstrap, the same chunk layout. Arms differ in exactly one thing —
# the file list handed to `nydusd --prefetch-files`. Experiment 3 varied the
# prefetch table at BUILD time, which reordered chunks and made each arm's blob
# a different physical object; that confounded "which files did it choose" with
# "how was the image packed". Here it cannot: there is one packing.
#
# Environment:
#   ARM BUDGET FAMILY SPEC REPO BLOB BOOTSTRAP PREFETCH_FILES PREFETCH_ALL
#   OBSERVE  (observation runs only: eager mount + the observe-only tracer)
#   EAGER_APP (observation runs only: a plain directory instead of a lazy mount)
set -u
ms(){ date +%s%3N; }
say(){ echo "#M $1 $(ms)"; }

# /work is a docker VOLUME, not the container's overlay layer: overlayfs refuses
# an upperdir that is itself overlayfs. Wiping it here (pre-t0) is the
# cold-start reset for the blobcache — no trial may inherit another's bytes.
rm -rf /work/* /work/.[!.]* 2>/dev/null
mkdir -p /work/cache /mnt/rafs /work/up /work/wd /mnt/app /scratch /out
cp "$SPEC" /work/spec.json
[ -n "${BOOTSTRAP:-}" ] && cp "$BOOTSTRAP" /work/boot.img
[ -n "${PREFETCH_FILES:-}" ] && cp "$PREFETCH_FILES" /work/prefetch.txt

envfile(){ node -e 'const s=require("/work/spec.json");for(const[k,v]of Object.entries(s.env))process.stdout.write(`export ${k}=${JSON.stringify(v)}\n`)'; }
cwdrel(){ node -e 'const s=require("/work/spec.json");process.stdout.write(s.cwdRel||"")'; }

# Scaffolding (config files, DB create/migrate/seed) runs against the EAGER copy,
# never the lazy mount: warming the cache here would prefetch for whichever arm
# happened to run it. Written as ONE script, not eval'd line by line, because
# several recipes' setup commands are multi-line.
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
  touch /work/prewarm-done          # an eager tree needs no prewarm
else
  LAZY=1
  cat > /work/cfg.json <<EOF
{"device":{"backend":{"type":"registry","config":{"scheme":"http","host":"reducer-registry:5000","repo":"$REPO","timeout":60,"connect_timeout":10,"retry_limit":2}},
 "cache":{"type":"blobcache","config":{"work_dir":"/work/cache"}}},
 "mode":"direct","digest_validate":false,"iostats_files":true,"access_pattern":true,"latest_read_files":true,
 "fs_prefetch":{"enable":true,"threads_count":4,"merging_size":131072,"prefetch_all":${PREFETCH_ALL:-false}}}
EOF
  PF=""
  [ -s /work/prefetch.txt ] && PF="--prefetch-files /work/prefetch.txt"
  # shellcheck disable=SC2086
  nydusd --config /work/cfg.json --mountpoint /mnt/rafs --bootstrap /work/boot.img $PF \
         --apisock /work/api.sock --log-level warn > /work/nydusd.log 2>&1 &
  for _ in $(seq 1 8000); do mountpoint -q /mnt/rafs && break; sleep 0.005; done
  mount -t overlay overlay -o lowerdir=/mnt/rafs,upperdir=/work/up,workdir=/work/wd /mnt/app || say overlay-failed
fi
say mount

if [ "$LAZY" = "1" ]; then
  node /opt/base/sampler.mjs /work/api.sock /work/samples.jsonl &
  SAMPLER=$!
  # PREWARM COMPLETION — the signal this whole experiment hangs on.
  #
  # `data_all_ready` is useless: it stays false even after a complete
  # prefetch_all. `prefetch_end_time_secs` is worse than useless — it is set
  # almost immediately, long before the bytes have arrived. Measured in the
  # pilot: the Next.js eager arm reported prefetch "ended" at t0+297 ms with
  # 64.6 MB of its 92.4 MB blob still unfetched, and then took 155 further
  # remote requests DURING the post-admission stream. Admitting traffic on that
  # signal would have silently destroyed the experiment's central distinction
  # between Ready and traffic-warm.
  #
  # What is true: `blobcache.prefetch_data_amount` counts prefetched bytes and
  # ONLY prefetched bytes (an on-demand fault does not move it). So prewarm is
  # complete when that counter stops advancing. Poll at 100 ms and require
  # PLATEAU consecutive quiet samples. The detection lag is charged identically
  # to every arm, and the last-progress instant is recorded separately so the
  # true prefetch end is preserved alongside the admission instant.
  PLATEAU=6
  ( LAST=-1; QUIET=0; PROG=$(ms)
    for _ in $(seq 1 180000); do
      A=$(curl -s --unix-socket /work/api.sock http://localhost/api/v1/metrics/blobcache | jq -r '.prefetch_data_amount' 2>/dev/null)
      [ -z "$A" ] && A=-1
      if [ "$A" != "$LAST" ]; then LAST=$A; QUIET=0; PROG=$(ms); else QUIET=$((QUIET+1)); fi
      [ "$QUIET" -ge "$PLATEAU" ] && [ "$A" != "-1" ] && break
      sleep 0.1
    done
    echo "#M prefetch-last-progress $PROG"
    echo "#M prewarm $(ms)"
    touch /work/prewarm-done ) &
else
  SAMPLER=""
fi

# ---- application. Started CONCURRENTLY with prewarm, which is what a pod does:
# the kubelet starts the container while the snapshotter is still fetching.
envfile > /work/appenv.sh
# shellcheck disable=SC1091
. /work/appenv.sh
CR=$(cwdrel)
mapfile -t ARGV < <(node -e 'const s=require("/work/spec.json");for(const a of s.argv)console.log(a)')
say proc
( cd "/mnt/app${CR:+/$CR}" 2>/dev/null || cd /mnt/app
  if [ "${OBSERVE:-0}" = "1" ]; then
    mkdir -p /work/trace
    export NODE_OPTIONS="--require /opt/base/tracer.cjs"
    export HYDRATION_TRACE_DIR=/work/trace HYDRATION_APP_ROOT=/mnt/app HYDRATION_RUN_LABEL="$ARM"
  fi
  exec node "${ARGV[@]}" ) > /work/app.log 2>&1 &
APP=$!

node /opt/driver/driver.mjs /work/spec.json /work/events.jsonl
DRV=$?
say workload-done

# ---- collection: after the measured window, so no virtiofs write is timed
if [ "$LAZY" = "1" ]; then
  for m in metrics metrics/backend metrics/blobcache; do
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
tail -c 60000 /work/app.log > /out/app.log 2>/dev/null
tail -c 20000 /work/nydusd.log > /out/nydusd.log 2>/dev/null
cat /sys/fs/cgroup/cpu.stat > /out/cpu.stat 2>/dev/null
echo "#M done $(ms) driver=$DRV"
exit 0
