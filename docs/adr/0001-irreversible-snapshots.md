# Irreversible snapshots

`globe2` keeps a single persistent World with no product-level cap on accumulated drawing history, but it still needs bounded live state for loading and interaction. Committed Drawings are permanent: mistakes, corrections, and revisions are handled by drawing over existing marks rather than removing them.

We will automatically create irreversible Snapshots that bake older Drawings into the Sphere's background image. This preserves the visual continuity of the World while reducing the amount of live Drawing state clients need to load and render.
