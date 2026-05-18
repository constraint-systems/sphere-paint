# S3 Snapshot face storage

Snapshot cube-map faces are stored outside Postgres as image objects: local filesystem files in development and AWS S3 objects in the live app. Postgres stores only Snapshot metadata and face locations so large binary Sphere backgrounds do not become part of the relational write path.
