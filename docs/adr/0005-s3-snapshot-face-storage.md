# S3 Snapshot face storage

Snapshot cube-map faces are stored outside Postgres as AWS S3 objects. Postgres stores only Snapshot metadata and face locations so large binary Sphere backgrounds do not become part of the relational write path.
