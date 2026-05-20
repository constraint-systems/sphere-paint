module.exports = {
  apps: [
    {
      name: "globe2-api",
      script: "apps/server/dist/src/server.js",
      cwd: "/var/www/globe2/current",
      interpreter: "node",
      node_args: "--env-file=.env",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "globe2-worker",
      script: "apps/server/dist/src/worker.js",
      cwd: "/var/www/globe2/current",
      interpreter: "node",
      node_args: "--env-file=.env",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
