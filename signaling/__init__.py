"""Signaling server for WebRTC peer connection establishment.

Handles SDP offer/answer exchange, ICE candidate relay, and room management.
No media passes through this server — it is purely a coordination layer.
"""
