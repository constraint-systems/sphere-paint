# Context

## Terms

### User
A person who participates in a shared drawing experience in the World.

### Guest
A User who enters the World without a persistent identity across visits.

### Visit
A single period of presence in the World for a Guest. Ownership of a Guest's Drawings lasts only for that Visit.

### Visit Identity
The temporary identity of a Guest during one Visit, including brief reconnects.

### World
The single persistent shared place where Users gather and draw on its one Sphere.

### Sphere
The one white globe-like surface within the World that Users draw on.

### View
A Guest's personal rotation and framing of the Sphere. A View does not change the World.

### URL View State
A shareable description of a Guest's View.

### View Orientation
The canonical orientation of a Guest's manual View of the Sphere.

### Initial View
The canonical Auto-Rotate View a Guest sees when first entering the World.

### Auto-Rotate View
A View mode that incrementally moves a Guest's View of the Sphere when enabled and not blocked by drawing-level zoom. It is represented separately from manual location-based View state.

### Drawing Zoom Threshold
The minimum zoom level at which drawing is allowed and Auto-Rotate View becomes suspended.

### Drawing Mode
The View state in which zoom permits creating Drawings.

### Presence Count
The current number of connected Users in the World.

### Drawing
A persistent, individually owned stroke created by a User on the surface of the Sphere, including its path, color, and brush size.

### Drawing Palette
The fixed set of colors available for Drawings.

### Brush Size
One of the fixed stroke widths available for Drawings.

### In-Progress Stroke
A live stroke segment visible to other connected Users before it is committed as a persistent Drawing. An In-Progress Stroke is not part of the World's durable state.

### Snapshot
An irreversible bake of existing Drawings into the Sphere's background image. A Snapshot preserves the World visually while reducing the amount of live Drawing state clients need to load.

## Relationships

- A **Guest** has at most one active **Visit Identity** during a **Visit**.
- A **Drawing** belongs to exactly one **Visit** when created by a **Guest**.
- A committed **Drawing** is permanent. Users correct or revise the World by drawing over existing Drawings.
- A **Snapshot** may bake a **Drawing** into the Sphere background, but it does not change the Drawing's permanence.
- A **Guest** changes their **View** of the **Sphere**; this does not rotate or otherwise change the shared **World**.
