import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // native ONNX runtime for the local cross-encoder reranker (src/lib/rerank.ts)
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node"],
};

export default nextConfig;
