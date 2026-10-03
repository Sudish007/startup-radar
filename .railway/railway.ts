// Railway infrastructure-as-code for Startup Radar (SDK: devDependency railway@3.12.0).
// Apply with: railway login; railway link (or railway init); railway config plan; railway config apply
//
// Declares one web service started with `npm start` (health check on /health) and one
// 1 GB volume mounted at /data; DATA_DIR=/data makes the SQLite database live on the volume.
// No restart policy is set here, so Railway's default restart policy applies.
import { defineRailway, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const data = volume("startup-radar-data", { sizeMB: 1024 });
  const web = service("startup-radar", {
    start: "npm start",
    healthcheck: "/health",
    healthcheckTimeout: 100,
    env: { DATA_DIR: "/data", REFRESH_MINUTES: "30", TZ: "UTC", NODE_ENV: "production" },
    volumeMounts: { "/data": data },
  });
  return project("startup-radar", { resources: [web, data] });
});
