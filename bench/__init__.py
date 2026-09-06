"""qvc bench daemon — drives (or emulates) a BB84 optical bench.

One daemon runs beside each bench: the source bench (pulsed laser +
attenuator + polarization modulator) and the detector bench (single-photon
detectors + timetagger). The daemon speaks a pairing-authenticated WebSocket
to the browser and an out-of-band "fiber" link to the peer daemon.

Everything above the driver ABCs in `drivers` is emulator-independent and
ships unchanged to the real bench; the emulated AWG/timetagger are just one
implementation of those ABCs.
"""
