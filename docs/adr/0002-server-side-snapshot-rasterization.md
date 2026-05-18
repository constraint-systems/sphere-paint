# Server-side snapshot rasterization

Snapshots are produced by a server-side background worker from canonical Sphere-coordinate Drawings, not by client browsers. This keeps the irreversible baked Sphere background authoritative, repeatable, and independent of any one Guest's device while allowing clients to remain responsible only for live interaction and rendering.
