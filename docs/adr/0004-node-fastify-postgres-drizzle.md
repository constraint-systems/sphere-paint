# Node Fastify server with Postgres and Drizzle

The app uses a separate TypeScript Node service with Fastify for HTTP and WebSocket behavior, while PostgreSQL is the source of truth for durable World state. The live app uses Railway-hosted Postgres while the app server and Snapshot worker run elsewhere. Drizzle owns schema definitions and migrations so the server, Snapshot worker, and typed application code share one explicit database model without making Vite or the browser tooling responsible for backend behavior.
