module.exports = {
  apps: [
    {
      name: "zalo-digest",
      script: "npm",
      args: "start",
      // Back off between restarts so a lost session doesn't hammer Zalo.
      exp_backoff_restart_delay: 60000,
      max_restarts: 20,
    },
  ],
};
