import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: false },
  reactStrictMode: false,
  serverExternalPackages: ["steem"],
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  /* UI Nuclear Override — הטרמינל חי מתחת-/saos-dex כדי שכל-הנכסים (chunks/HMR/API)
   * ייטענו דרך-origin-אחד חשוף (השער מעביר רק-בקשות עם XTransformPort; בלי-basePath
   * ה-HTML מגיע וה-chunks 404 → מסך-ריק. עם basePath + rewrite בשרת-האם — הכול זורם). */
  basePath: "/saos-dex",
};

export default nextConfig;
