# Linux VPS process deployment

The live app runs directly on a Linux VPS rather than inside Docker containers. Nginx serves the built React assets, terminates TLS, and reverse-proxies API and WebSocket traffic to PM2-managed Node processes for the app server and Snapshot worker. This keeps v1 deployment simple for the expected operating environment, while requiring explicit process management for logs, environment variables, Railway Postgres access, and AWS S3 credentials.
