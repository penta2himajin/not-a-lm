import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node"],
  // Cloudflare quick tunnel (trycloudflare.com) from an external browser.
  allowedDevOrigins: ["*.trycloudflare.com"],
};

export default nextConfig;
