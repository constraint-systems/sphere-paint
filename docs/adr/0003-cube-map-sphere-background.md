# Cube-map Sphere background

The Sphere's baked background is represented as a cube-map made of six square faces rather than a single equirectangular texture. Drawings remain canonical Sphere-coordinate paths, but Snapshot rasterization outputs cube faces to reduce polar distortion, align with face-based rendering, and keep the baked visual state tile-like for loading and regeneration.
