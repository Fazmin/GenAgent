import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  reactCompiler: true,
  serverExternalPackages: ["better-sqlite3", "gen-agent", "@mariozechner/pi-ai", "dotenv"],
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
