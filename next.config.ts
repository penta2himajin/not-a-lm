import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node"],
  allowedDevOrigins: ["*.trycloudflare.com"],
};

export default nextConfig;
