FROM coturn/coturn:4.6

# Static config (no secrets); secrets are injected at runtime by the entrypoint.
COPY turnserver.conf /etc/coturn/turnserver.conf
COPY entrypoint.sh /usr/local/bin/qvc-turn-entrypoint.sh
RUN chmod +x /usr/local/bin/qvc-turn-entrypoint.sh

# STUN/TURN signalling ports; relay ports 49160-49200 (see turnserver.conf)
# must also be reachable.
EXPOSE 3478/udp 3478/tcp 5349/tcp

ENTRYPOINT ["/usr/local/bin/qvc-turn-entrypoint.sh"]
