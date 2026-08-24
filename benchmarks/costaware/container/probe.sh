#!/usr/bin/env bash
# One COST-MODEL CALIBRATION probe: mount the frozen image with a given prefetch
# list, let nydusd prefetch it, and report what the backend actually did.
#
# No application, no traffic, no strategy. The manifests handed to this script
# are neutral by construction (`calibrate.ts`): contiguous spans and seeded
# uniform samples of the universe. Nothing derived from TRAIN, from TEST or from
# any arm's ranking ever reaches it, which is what makes the fitted coefficients
# usable to select content without circularity.
#
# Env: REPO BOOTSTRAP PREFETCH_FILES
set -u
ms(){ date +%s%3N; }
say(){ echo "#M $1 $(ms)"; }

rm -rf /work/* /work/.[!.]* 2>/dev/null
mkdir -p /work/cache /mnt/rafs
cp "$BOOTSTRAP" /work/boot.img
cp "$PREFETCH_FILES" /work/prefetch.txt

cat > /work/cfg.json <<EOF
{"device":{"backend":{"type":"registry","config":{"scheme":"http","host":"reducer-registry:5000","repo":"$REPO","timeout":60,"connect_timeout":10,"retry_limit":2}},
 "cache":{"type":"blobcache","config":{"work_dir":"/work/cache"}}},
 "mode":"direct","digest_validate":false,"iostats_files":true,"access_pattern":true,"latest_read_files":true,
 "fs_prefetch":{"enable":true,"threads_count":4,"merging_size":131072,"prefetch_all":false}}
EOF

say t0
nydusd --config /work/cfg.json --mountpoint /mnt/rafs --bootstrap /work/boot.img \
       --prefetch-files /work/prefetch.txt --apisock /work/api.sock --log-level warn \
       > /work/nydusd.log 2>&1 &
for _ in $(seq 1 8000); do mountpoint -q /mnt/rafs && break; sleep 0.005; done
say mount

# Same plateau detector the measured trials use: prefetch_data_amount counts
# prefetched bytes and only prefetched bytes, so prewarm is over when it stops
# advancing. The last-progress instant is the true end; the plateau instant is
# the end plus a detection lag charged identically everywhere.
PLATEAU=6
LAST=-1; QUIET=0; PROG=$(ms)
for _ in $(seq 1 180000); do
  A=$(curl -s --unix-socket /work/api.sock http://localhost/api/v1/metrics/blobcache | jq -r '.prefetch_data_amount' 2>/dev/null)
  [ -z "$A" ] && A=-1
  if [ "$A" != "$LAST" ]; then LAST=$A; QUIET=0; PROG=$(ms); else QUIET=$((QUIET+1)); fi
  [ "$QUIET" -ge "$PLATEAU" ] && [ "$A" != "-1" ] && break
  sleep 0.1
done
echo "#M last-progress $PROG"
say plateau

for m in metrics metrics/backend metrics/blobcache; do
  n=$(echo "$m" | tr '/' '.')
  curl -s --unix-socket /work/api.sock "http://localhost/api/v1/$m" > "/out/final.${n}.json"
done
cp /work/nydusd.log /out/nydusd.log 2>/dev/null
echo "#M done $(ms)"
exit 0
