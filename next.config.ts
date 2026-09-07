import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: false },
  reactStrictMode: false,
  serverExternalPackages: ["steem"],
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
