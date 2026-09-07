#!/bin/sh
# Inject runtime secrets into coturn without baking them into the image.
# TURN_SECRET must match QVC_TURN_SECRET on the signaling server.
set -eu

exec turnserver \
  -c /etc/coturn/turnserver.conf \
  --static-auth-secret="${TURN_SECRET:?TURN_SECRET is required}" \
  --realm="${TURN_REALM:-qvc.turn}" \
  ${TURN_EXTERNAL_IP:+--external-ip="$TURN_EXTERNAL_IP"}
