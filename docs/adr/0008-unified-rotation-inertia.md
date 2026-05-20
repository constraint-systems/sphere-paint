# Unified rotation inertia with trackpad pass-through

All rotation sources (pointer drag, scroll wheel, keyboard) feed into one shared `{ axis, speed }` inertia state that decays with a single damping constant (0.95/frame). Any intentional input — pointer down or first keydown — interrupts inertia immediately.

macOS trackpad scroll events are excluded from our inertia because the OS already provides momentum: the browser keeps delivering decreasing-delta wheel events after the user lifts their fingers. We detect trackpad events as `deltaMode === 0` with `Math.abs(deltaY) < 40`; those get direct rotation only. Physical scroll wheels (`deltaMode !== 0`, or pixel-mode with large discrete deltas ≥ 40px) go through our inertia system.

The previous design had two separate inertia representations (`{ axis, speed }` for pointer, `{ deltaX, deltaY }` for wheel) running in a mutually exclusive else-if chain, and keyboard had no inertia at all. Unifying removes the duplication and makes keyboard rotation feel consistent with dragging.
