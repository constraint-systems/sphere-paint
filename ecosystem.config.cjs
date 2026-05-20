module.exports = {
  apps: [
    {
      name: "sphere-paint-api",
      script: "node_modules/.bin/tsx",
      args: "apps/server/src/server.ts",
      cwd: __dirname,
      interpreter: "node",
      node_args: "--env-file=.env",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "sphere-paint-worker",
      script: "node_modules/.bin/tsx",
      args: "apps/server/src/worker.ts",
      cwd: __dirname,
      interpreter: "node",
      node_args: "--env-file=.env",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
