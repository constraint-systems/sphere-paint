# Manual View orientation quaternion

Manual URL View State stores a normalized Sphere-to-View orientation quaternion, plus zoom, rather than yaw/pitch angles or a center-point coordinate. This supports grab-and-keep surface dragging, preserves roll, avoids pole/up-vector discontinuities, and makes shared manual View links reload exactly. Auto-Rotate remains separate: it incrementally moves the current View orientation while active, and the current Auto-Rotate orientation is not stored in the URL.
